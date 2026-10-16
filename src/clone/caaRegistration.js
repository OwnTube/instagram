'use strict';

/**
 * The genuine sign-up form ("Get started on Instagram with a Meta Account",
 * CAARegistrationFormDesktop) talks to three GraphQL operations. Their
 * variables and selections were read from the client's own modules
 * (useCAARegistrationFormSubmitMutation, useCAARegistrationFieldValidationQuery,
 * useCAARegistrationUsernameTypeaheadQuery, CAARegistrationFormDesktopReducer):
 *
 *   submit     input.reg_data.{username, fullname, reg_passwd__, contactpoint}
 *              each as {sensitive_string_value}, plus birthday_day/month/year
 *              (or birthday_age); answered under caa_registration_homepage_submit
 *              with status (CAARegCreationStatus name) and
 *              errors.creation_errors[{field, code, message}].
 *   validate   input.field_name (CAARegistrationFieldValidationFields name) and
 *              the same field values; answered under
 *              xfb_caa_registration_field_validation.
 *   typeahead  input.sensitive_string_value; answered with username_suggestions.
 *
 * Enum values travel as their names ("SUCCESS", "USERNAME"); the client maps
 * them back with $InternalEnumUtils.createToJSEnum.
 *
 * Accounts need only a username and a password. A contact point, if one is
 * still sent, may be an email (stored, validated, optional); a phone number is
 * refused rather than silently dropped, since this server cannot verify it.
 */

const MIN_AGE = 13;

const sensitive = (v) => {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof v.sensitive_string_value === 'string') return v.sensitive_string_value;
  return '';
};

/** REST error field -> CAARegistrationCreateAccountErrorFields name. */
const FIELD = { username: 'USERNAME', email: 'CONTACTPOINT', password: 'PASSWORD', first_name: 'FULLNAME', birthday: 'BIRTHDAY', __all__: 'GENERAL' };
/** REST error code -> CAARegistrationCreateAccountWebErrorCodes name. */
const CODE = {
  username_invalid: 'USER_REGISTER_USERNAME_ERROR',
  username_is_taken: 'USER_REGISTER_USERNAME_ERROR',
  email_invalid: 'USER_REGISTER_INVALID_EMAIL',
  email_is_taken: 'USER_REGISTER_EMAIL_TAKEN',
  password_too_weak: 'USER_REGISTER_PASSWORD_WEAK',
  name_too_long: 'USER_REGISTER_INVALID_NAME',
  birthday_incomplete: 'USER_REGISTER_INCOMPLETE_BDAY',
  too_young: 'USER_REGISTER_TOO_YOUNG',
  phone_unsupported: 'USER_REGISTER_MOBILE_PHONE_INVALID',
  password_unreadable: 'PASSWORD_GENERIC',
};

/** Only same-site paths: a post-auth redirect must not leave the origin. */
function safeNext(next) {
  return typeof next === 'string' && /^\/(?![/\\])/.test(next) ? next : '/';
}

function contactPoint(data) {
  const cp = sensitive(data.contactpoint).trim();
  if (!cp) return { email: undefined };
  if (cp.includes('@')) return { email: cp };
  return { error: { contactpoint: [{ message: 'Sign up with a username and password. Phone numbers are not used on this site.', code: 'phone_unsupported' }] } };
}

function ageError(data) {
  const age = Number(data.birthday_age);
  if (data.did_use_age === true && Number.isFinite(age)) {
    return age >= MIN_AGE ? null : { birthday: [{ message: 'You must be at least 13 years old to sign up.', code: 'too_young' }] };
  }
  const y = Number(data.birthday_year);
  const m = Number(data.birthday_month);
  const d = Number(data.birthday_day);
  if (![y, m, d].every(Number.isInteger)) return { birthday: [{ message: 'Enter your birthday.', code: 'birthday_incomplete' }] };
  const born = new Date(Date.UTC(y, m - 1, d));
  if (born.getUTCMonth() !== m - 1 || born.getTime() > Date.now()) return { birthday: [{ message: 'Enter a valid birthday.', code: 'birthday_incomplete' }] };
  const now = new Date();
  let years = now.getUTCFullYear() - y;
  if (now.getUTCMonth() < m - 1 || (now.getUTCMonth() === m - 1 && now.getUTCDate() < d)) years -= 1;
  return years >= MIN_AGE ? null : { birthday: [{ message: 'You must be at least 13 years old to sign up.', code: 'too_young' }] };
}

function creationErrors(errors) {
  return Object.entries(errors).map(([field, list]) => ({
    field: FIELD[field === 'contactpoint' ? 'email' : field] || 'GENERAL',
    code: CODE[list[0].code] || 'USER_REGISTER_GENERIC_ERROR',
    message: list[0].message,
  }));
}

function submitPayload(fields) {
  return {
    status: 'SUCCESS',
    captcha_persist_data: null,
    client_mutation_id: null,
    created_user_id: null,
    redirect_uri: null,
    should_show_youth_consent_dialog: false,
    regulation_jurisdiction: null,
    age_range: null,
    youth_regulation_enabled: false,
    errors: null,
    age_block_check: null,
    context: { ntf_context: null },
    ...fields,
  };
}

function createCaaRegistration(getCore) {
  async function submit(vars, ctx) {
    const core = getCore();
    if (!core) throw new Error('signup is not wired');
    const input = vars.input && typeof vars.input === 'object' ? vars.input : {};
    const data = input.reg_data && typeof input.reg_data === 'object' ? input.reg_data : {};
    const clientMutationId = typeof input.client_mutation_id === 'string' ? input.client_mutation_id : null;
    const fail = (errors) =>
      ({ caa_registration_homepage_submit: submitPayload({ status: 'HAS_VALIDATION_ERRORS', client_mutation_id: clientMutationId, errors: { creation_errors: creationErrors(errors) } }) });

    const cp = contactPoint(data);
    if (cp.error) return fail(cp.error);
    const age = ageError(data);
    if (age) return fail(age);

    const secret = sensitive(data.reg_passwd__);
    let password;
    try {
      password = core.readPassword(secret.startsWith('#PWD_') ? { enc_password: secret } : { password: secret });
    } catch (error) {
      if (error && error.status === 400) return fail({ password: [{ message: error.message, code: 'password_unreadable' }] });
      throw error;
    }
    const fields = { username: sensitive(data.username).trim(), first_name: sensitive(data.fullname).trim(), email: cp.email };
    const result = await core.createAccount(ctx.req, ctx.res, fields, password);
    if (result.errors) return fail(result.errors);
    return {
      caa_registration_homepage_submit: submitPayload({
        client_mutation_id: clientMutationId,
        created_user_id: result.user.pk,
        redirect_uri: safeNext(input.next_uri),
      }),
    };
  }

  /**
   * Per-field checks the form runs on blur. Nothing is written. The password
   * check receives the password in clear (that is what the client sends to
   * this query); it is only length/character checked and never stored or logged.
   */
  function validate(vars) {
    const core = getCore();
    if (!core) throw new Error('signup is not wired');
    const input = vars.input && typeof vars.input === 'object' ? vars.input : {};
    const name = String(input.field_name || '');
    let errors = {};
    if (name === 'USERNAME') {
      const username = sensitive(input.username).trim();
      errors = core.validateSignup({ username }, 'placeholder-password-1');
      delete errors.password;
    } else if (name === 'PASSWORD') {
      errors = core.validateSignup({ username: 'placeholder_user' }, sensitive(input.reg_passwd__));
      delete errors.username;
    } else if (name === 'FULLNAME') {
      errors = core.validateSignup({ username: 'placeholder_user', first_name: sensitive(input.fullname) }, 'placeholder-password-1');
      delete errors.username;
    } else if (name === 'CONTACTPOINT') {
      const cp = contactPoint(input);
      if (cp.error) errors = cp.error;
      else if (cp.email) {
        errors = core.validateSignup({ username: 'placeholder_user', email: cp.email }, 'placeholder-password-1');
        delete errors.username;
      }
    }
    const [first] = creationErrors(errors);
    const wantSuggestions = input.fetch_username_suggestions === true && name === 'USERNAME' && errors.username;
    return {
      xfb_caa_registration_field_validation: {
        status: first ? 'VALIDATION_ERROR' : 'SUCCESS',
        error: first ? { ...first, msg_text_with_entities: null } : null,
        username_suggestions: wantSuggestions ? core.suggestions(sensitive(input.username)) : [],
        regulation_jurisdiction: null,
        age_range: null,
        youth_regulation_enabled: false,
      },
    };
  }

  function typeahead(vars) {
    const core = getCore();
    if (!core) throw new Error('signup is not wired');
    const raw = sensitive(vars.input).trim();
    return { xfb_caa_registration_homepage_fetch_username_typeahead: { username_suggestions: raw.length >= 3 ? core.suggestions(raw) : [] } };
  }

  return {
    useCAARegistrationFormSubmitMutation: submit,
    useCAARegistrationFieldValidationQuery: validate,
    useCAARegistrationUsernameTypeaheadQuery: typeahead,
  };
}

module.exports = { createCaaRegistration, safeNext };
