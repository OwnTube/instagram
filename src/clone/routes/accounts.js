'use strict';

/**
 * Account endpoints of the original client: login, logout, signup, profile
 * editing, profile picture and privacy. Every one authenticates against OUR
 * database; nothing is forwarded to Instagram.
 */

const crypto = require('node:crypto');
const users = require('../../backend/services/users');
const sessions = require('../../backend/services/sessions');
const { settings } = require('../../backend/services/social');
const v = require('../../backend/lib/validate');
const { AppError, badRequest } = require('../../backend/lib/errors');
const { newId, nowIso, addMs, hashToken, randomToken, timingSafeEqual } = require('../../backend/lib/ids');
const { PasswordFormatError } = require('../passwordEncryption');
const { igOk, igFail } = require('../respond');
const { issueSession, endSession } = require('../session');
const present = require('../present');

const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;

/** Validation results in the `errors` map the signup form renders under each field. */
function fieldErrors(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    if (error instanceof AppError) return error.message;
    throw error;
  }
}

function register(router, ctx) {
  const { db, codec, mailer, limits, requireViewer, media } = ctx;

  function readPassword(p) {
    if (p.enc_password) {
      try {
        return codec.decrypt(String(p.enc_password));
      } catch (error) {
        if (error instanceof PasswordFormatError) throw badRequest('Password could not be read. Refresh the page and try again.');
        throw error;
      }
    }
    if (typeof p.password === 'string') return p.password;
    throw badRequest('Password is required');
  }

  /* --------------------------------- login -------------------------------- */

  async function login(req, res) {
    const p = req.params_;
    const username = String(p.username || '').trim();
    if (!username) return igFail(res, 400, 'Please enter your username.');
    const password = readPassword(p);
    try {
      const user = await users.authenticate(db, { username, password });
      const full = users.getById(db, user.id);
      issueSession(db, req, res, full);
      return igOk(res, { user: true, userId: full.pk, authenticated: true, oneTapPrompt: false, reactivated: false });
    } catch (error) {
      if (error instanceof AppError && error.status === 401) {
        // One answer whether or not the account exists, so the form cannot be
        // used to enumerate usernames.
        return igOk(res, { user: true, authenticated: false });
      }
      throw error;
    }
  }
  for (const path of ['/api/v1/web/accounts/login/ajax/', '/accounts/login/ajax/']) router.post(path, limits.auth, login);

  function logout(req, res) {
    endSession(db, req, res);
    return igOk(res, {});
  }
  for (const path of ['/api/v1/web/accounts/logout/ajax/', '/accounts/logout/ajax/', '/api/v1/accounts/logout/']) router.post(path, logout);

  /* -------------------------------- signup -------------------------------- */

  function validateSignup(p, password) {
    const errors = {};
    const add = (field, message, code) => {
      if (message) errors[field] = [{ message, code }];
    };
    add('username', fieldErrors(() => v.username(String(p.username ?? ''))), 'username_invalid');
    if (!errors.username && users.getByUsername(db, p.username)) add('username', `A user with that username already exists.`, 'username_is_taken');
    add('email', fieldErrors(() => v.email(String(p.email ?? ''))), 'email_invalid');
    if (!errors.email && db.prepare('SELECT 1 FROM users WHERE email_ci = ?').get(String(p.email).toLowerCase())) {
      add('email', 'Another account is using the same email.', 'email_is_taken');
    }
    add('password', fieldErrors(() => v.password(password)), 'password_too_weak');
    if (p.first_name && String(p.first_name).length > 100) add('first_name', 'Name is too long.', 'name_too_long');
    return errors;
  }

  function suggestions(username) {
    const base = String(username || 'user').toLowerCase().replace(/[^a-z0-9._]/g, '').slice(0, 24) || 'user';
    const out = [];
    for (let i = 0; out.length < 3 && i < 20; i += 1) {
      const candidate = `${base}${crypto.randomInt(10, 9999)}`;
      if (!users.getByUsername(db, candidate)) out.push(candidate);
    }
    return out;
  }

  function attempt(req, res) {
    const p = req.params_;
    const password = readPassword(p);
    const errors = validateSignup(p, password);
    if (Object.keys(errors).length) {
      return igOk(res, {
        account_created: false,
        errors,
        dryrun_passed: false,
        username_suggestions: errors.username ? suggestions(p.username) : [],
        error_type: 'form_validation_error',
      });
    }
    return igOk(res, { account_created: false, dryrun_passed: true, username_suggestions: [] });
  }
  for (const path of ['/api/v1/web/accounts/web_create_ajax/attempt/', '/accounts/web_create_ajax/attempt/']) {
    router.post(path, limits.auth, attempt);
  }

  function ageEligibility(req, res) {
    const p = req.params_;
    const y = Number(p.year);
    const m = Number(p.month);
    const d = Number(p.day);
    if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return igFail(res, 400, 'Enter your birthday.');
    const born = Date.UTC(y, m - 1, d);
    const age = (Date.now() - born) / (365.25 * 24 * 3600 * 1000);
    return igOk(res, { eligible_to_register: age >= 13 && age < 130, parental_consent_required: false });
  }
  for (const path of ['/api/v1/web/consent/check_age_eligibility/', '/web/consent/check_age_eligibility/']) {
    router.post(path, ageEligibility);
  }

  async function sendVerifyEmail(req, res) {
    const email = v.email(String(req.params_.email ?? ''));
    if (!mailer.enabled) return igFail(res, 503, 'Email delivery is not configured on this server.');
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    db.prepare(
      'INSERT INTO signup_codes (id, email_ci, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
    ).run(newId('code'), email, hashToken(`${email}:${code}`), nowIso(), addMs(CODE_TTL_MS));
    await mailer.sendSignupCode(email, code);
    return igOk(res, { email_sent: true, require_captcha: false });
  }
  router.post('/api/v1/accounts/send_verify_email/', limits.auth, sendVerifyEmail);

  function checkCode(req, res) {
    const email = v.email(String(req.params_.email ?? ''));
    const code = String(req.params_.code ?? '').trim();
    const row = db
      .prepare('SELECT * FROM signup_codes WHERE email_ci = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1')
      .get(email);
    const invalid = () => igFail(res, 400, "That code isn't valid. You can request a new one.", { error_type: 'invalid_code' });
    if (!row || Date.parse(row.expires_at) <= Date.now() || row.attempts >= CODE_MAX_ATTEMPTS) return invalid();
    db.prepare('UPDATE signup_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    if (!/^\d{6}$/.test(code) || !timingSafeEqual(hashToken(`${email}:${code}`), row.code_hash)) return invalid();
    const signupCode = randomToken(24);
    db.prepare('UPDATE signup_codes SET consumed_at = ?, signup_token_hash = ? WHERE id = ?').run(nowIso(), hashToken(signupCode), row.id);
    return igOk(res, { signup_code: signupCode });
  }
  router.post('/api/v1/accounts/check_confirmation_code/', limits.auth, checkCode);

  async function create(req, res) {
    const p = req.params_;
    const password = readPassword(p);
    const errors = validateSignup(p, password);
    if (Object.keys(errors).length) {
      return igFail(res, 400, 'Please correct the highlighted fields.', { account_created: false, errors, error_type: 'form_validation_error' });
    }
    const email = String(p.email).toLowerCase();
    if (ctx.config.requireEmailCode) {
      const token = String(p.force_sign_up_code || p.signup_code || '');
      const row = token
        ? db.prepare('SELECT id, email_ci, created_at FROM signup_codes WHERE signup_token_hash = ?').get(hashToken(token))
        : null;
      if (!row || row.email_ci !== email || Date.now() - Date.parse(row.created_at) > 2 * CODE_TTL_MS) {
        return igFail(res, 400, 'Confirm your email address to finish signing up.', { account_created: false, error_type: 'signup_code_required' });
      }
      db.prepare('UPDATE signup_codes SET signup_token_hash = NULL WHERE id = ?').run(row.id);
    }
    const user = await users.createUserAsync(db, {
      username: String(p.username).trim(),
      email,
      password,
      displayName: p.first_name ? String(p.first_name).trim().slice(0, 100) : undefined,
    });
    issueSession(db, req, res, user);
    return igOk(res, { account_created: true, user_id: user.pk });
  }
  for (const path of ['/api/v1/web/accounts/web_create_ajax/', '/accounts/web_create_ajax/']) router.post(path, limits.auth, create);

  /* ------------------------------ current user ---------------------------- */

  router.get('/api/v1/accounts/current_user/', requireViewer, (req, res) => {
    const row = users.getById(db, req.viewer.id);
    return igOk(res, { user: { ...present.userInfo(db, row, req.viewer.id), email: row.email ?? '' } });
  });

  router.get('/api/v1/accounts/edit/web_form_data/', requireViewer, (req, res) => {
    const row = users.getById(db, req.viewer.id);
    return igOk(res, {
      form_data: {
        first_name: row.display_name ?? '',
        last_name: '',
        email: row.email ?? '',
        is_email_confirmed: Boolean(row.email),
        is_phone_confirmed: false,
        username: row.username,
        phone_number: '',
        gender: 3,
        birthday: null,
        biography: row.bio ?? '',
        external_url: row.external_url ?? '',
        chaining_enabled: false,
        presence_disabled: false,
        business_account: false,
        usertag_review_enabled: false,
        custom_gender: '',
        trusted_username: '',
        trust_days: 0,
      },
    });
  });

  function editProfile(req, res) {
    const p = req.params_;
    const fields = {};
    if (p.username !== undefined) fields.username = v.username(String(p.username));
    if (p.email !== undefined) fields.email = p.email === '' ? null : v.email(String(p.email));
    if (p.first_name !== undefined) fields.displayName = String(p.first_name).trim().slice(0, 100) || null;
    if (p.biography !== undefined) fields.bio = v.optionalStr(String(p.biography), 'biography', { max: 150 }) ?? null;
    if (p.external_url !== undefined) {
      const url = String(p.external_url).trim();
      if (url && !/^https?:\/\/[^\s]{1,2000}$/i.test(url)) throw badRequest('Enter a valid website (http:// or https://).');
      fields.externalUrl = url || null;
    }
    users.updateProfile(db, req.viewer.id, fields);
    return igOk(res, {});
  }
  for (const path of ['/api/v1/web/accounts/edit/', '/accounts/edit/']) router.post(path, requireViewer, editProfile);

  function changePicture(req, res) {
    const file = req.files?.profile_pic;
    if (!file) {
      users.updateProfile(db, req.viewer.id, { avatarUrl: null });
      db.prepare('UPDATE users SET avatar_media_id = NULL WHERE id = ?').run(req.viewer.id);
      return igOk(res, { changed_profile: true, has_profile_pic: false, profile_pic_url: present.DEFAULT_AVATAR });
    }
    const stored = media.save(req.viewer.id, file, { purpose: 'avatar' });
    media.markAttached(stored.id);
    db.prepare('UPDATE users SET avatar_url = ?, avatar_media_id = ?, updated_at = ? WHERE id = ?').run(stored.url, stored.id, nowIso(), req.viewer.id);
    return igOk(res, {
      changed_profile: true,
      id: req.viewer.pk,
      has_profile_pic: true,
      profile_pic_url: stored.url,
      profile_pic_url_hd: stored.url,
    });
  }
  router.post('/api/v1/web/accounts/web_change_profile_picture/', requireViewer, ctx.multipart, changePicture);

  function setPrivacy(isPrivate) {
    return (req, res) => {
      const value = isPrivate ?? ['true', '1', 'on'].includes(String(req.params_.is_private).toLowerCase());
      settings.update(db, req.viewer.id, { isPrivate: value });
      return igOk(res, { user: present.userInfo(db, users.getById(db, req.viewer.id), req.viewer.id) });
    };
  }
  router.post('/api/v1/accounts/set_private/', requireViewer, setPrivacy(true));
  router.post('/api/v1/accounts/set_public/', requireViewer, setPrivacy(false));
  router.post('/api/v1/web/accounts/set_private/', requireViewer, setPrivacy(null));

  router.post('/api/v1/web/accounts/password/change/', requireViewer, limits.auth, async (req, res) => {
    const p = req.params_;
    const read = (field) => (p[`enc_${field}`] ? codec.decrypt(String(p[`enc_${field}`])) : String(p[field] ?? ''));
    const oldPassword = read('old_password');
    const newPassword = v.password(read('new_password1'));
    if (newPassword !== read('new_password2')) throw badRequest('Please make sure both passwords match.');
    try {
      await users.authenticate(db, { username: req.viewer.username, password: oldPassword });
    } catch (error) {
      if (error instanceof AppError && error.status === 401) throw badRequest('Your old password was entered incorrectly.');
      throw error;
    }
    await users.setPassword(db, req.viewer.id, newPassword);
    sessions.revokeAllForUser(db, req.viewer.id);
    issueSession(db, req, res, users.getById(db, req.viewer.id));
    return igOk(res, {});
  });

}

module.exports = { register };
