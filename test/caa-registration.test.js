'use strict';

/**
 * The genuine sign-up form's GraphQL operations, with the input shapes the
 * client builds (CAARegistrationFormDesktopReducer.getMutationPayload and
 * CAARegistrationFormFieldValidationHelpers). Database state is checked
 * directly. That the genuine form completes against these answers is checked
 * separately in a real browser.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { startCloneServer, Browser } = require('./clone-helpers');

const PASSWORD = 'correct horse 42';
const sens = (v) => ({ sensitive_string_value: v });

async function regData(b, { username, password = PASSWORD, fullname = 'Reg Test', contactpoint = '', birthday = [1, 1, 1990], age } = {}) {
  const [day, month, year] = birthday || [];
  return {
    birthday_age: age,
    birthday_day: day,
    birthday_month: month,
    birthday_year: year,
    contactpoint: sens(contactpoint),
    contactpoint_type: 'ANY',
    custom_gender: '',
    did_use_age: age !== undefined,
    firstname: sens(''),
    fullname: sens(fullname),
    ig_age_block_data: null,
    lastname: sens(''),
    preferred_pronoun: null,
    reg_passwd__: sens(await b.encPassword(password)),
    sex: null,
    use_custom_gender: false,
    username: sens(username),
  };
}

const gql = (b, name, variables) => b.post('/graphql/query', { doc_id: '1', fb_api_req_friendly_name: name, variables });

async function submit(b, opts, extra = {}) {
  await b.visit('/accounts/emailsignup/');
  const input = { client_mutation_id: 'cm-1', machine_id: '', next_uri: null, reg_data: await regData(b, opts), sk_pipa_consent_given: null, waterfall_id: 'w', ...extra };
  return gql(b, 'useCAARegistrationFormSubmitMutation', { input });
}

test('genuine sign-up form (CAA registration)', async (t) => {
  const server = await startCloneServer({});
  t.after(() => server.close());
  const db = server.openDb();
  t.after(() => db.close());
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

  await t.test('a username, password and birthday create an account and sign this browser in', async () => {
    const b = new Browser(server.base);
    const res = await submit(b, { username: 'caa_user' });
    assert.strictEqual(res.status, 200);
    const out = res.body.data.caa_registration_homepage_submit;
    assert.strictEqual(out.status, 'SUCCESS');
    assert.strictEqual(out.errors, null);
    assert.strictEqual(out.redirect_uri, '/');
    assert.strictEqual(out.client_mutation_id, 'cm-1');
    const row = db.prepare("SELECT * FROM users WHERE username_ci = 'caa_user'").get();
    assert.ok(row, 'the user row exists');
    assert.strictEqual(out.created_user_id, row.pk);
    assert.strictEqual(row.email, null);
    assert.strictEqual(row.display_name, 'Reg Test');
    assert.ok(!row.password_hash.includes(PASSWORD));
    assert.strictEqual(b.cookie('ds_user_id'), row.pk);
    assert.strictEqual((await b.get('/api/v1/accounts/current_user/')).body.user.username, 'caa_user');
  });

  await t.test('the new account logs in through the genuine login mutation', async () => {
    const b = new Browser(server.base);
    await b.visit('/accounts/login/');
    const res = await gql(b, 'useCDSWebLoginMutation', { input: { identifier: 'caa_user', enc_password: sens(await b.encPassword(PASSWORD)) }, scale: 1 });
    assert.strictEqual(res.body.data.caa_login_web.ig_authenticated, true);
    assert.strictEqual((await b.get('/api/v1/accounts/current_user/')).body.user.username, 'caa_user');
  });

  await t.test('a duplicate username is a USERNAME error and writes nothing', async () => {
    const before = count();
    const b = new Browser(server.base);
    const out = (await submit(b, { username: 'CAA_User' })).body.data.caa_registration_homepage_submit;
    assert.strictEqual(out.status, 'HAS_VALIDATION_ERRORS');
    assert.strictEqual(out.created_user_id, null);
    assert.strictEqual(out.redirect_uri, null);
    assert.deepStrictEqual(out.errors.creation_errors.map((e) => e.field), ['USERNAME']);
    assert.ok(out.errors.creation_errors[0].message);
    assert.strictEqual(count(), before);
    assert.strictEqual(b.cookie('ds_user_id'), undefined, 'no session for a failed sign-up');
  });

  await t.test('invalid input is reported per field and writes nothing', async () => {
    const before = count();
    const b = new Browser(server.base);
    const cases = [
      [{ username: 'x' }, 'USERNAME'],
      [{ username: 'weak_pw_user', password: 'short' }, 'PASSWORD'],
      [{ username: 'young_user', birthday: [1, 1, new Date().getUTCFullYear() - 5] }, 'BIRTHDAY'],
      [{ username: 'no_bday_user', birthday: null }, 'BIRTHDAY'],
      [{ username: 'phone_user', contactpoint: '+15555550100' }, 'CONTACTPOINT'],
      [{ username: 'bad_email_user', contactpoint: 'not@valid' }, 'CONTACTPOINT'],
    ];
    for (const [opts, field] of cases) {
      const out = (await submit(b, opts)).body.data.caa_registration_homepage_submit;
      assert.strictEqual(out.status, 'HAS_VALIDATION_ERRORS', JSON.stringify(opts));
      assert.ok(out.errors.creation_errors.some((e) => e.field === field), `${JSON.stringify(opts)} -> ${JSON.stringify(out.errors)}`);
    }
    assert.strictEqual(count(), before);
  });

  await t.test('an optional email contact point is stored; the age flow works', async () => {
    const b = new Browser(server.base);
    const out = (await submit(b, { username: 'caa_mail', contactpoint: 'caa.mail@example.test', birthday: null, age: 30 })).body.data.caa_registration_homepage_submit;
    assert.strictEqual(out.status, 'SUCCESS', JSON.stringify(out.errors));
    assert.strictEqual(db.prepare("SELECT email FROM users WHERE username_ci = 'caa_mail'").get().email, 'caa.mail@example.test');
  });

  await t.test('an unreadable password is a PASSWORD error, not a crash', async () => {
    const b = new Browser(server.base);
    await b.visit('/accounts/emailsignup/');
    const data = await regData(b, { username: 'garbled_user' });
    data.reg_passwd__ = sens('#PWD_INSTAGRAM_BROWSER:10:1:bm9wZQ==');
    const out = (await gql(b, 'useCAARegistrationFormSubmitMutation', { input: { reg_data: data } })).body.data.caa_registration_homepage_submit;
    assert.strictEqual(out.status, 'HAS_VALIDATION_ERRORS');
    assert.strictEqual(out.errors.creation_errors[0].field, 'PASSWORD');
  });

  await t.test('the redirect after sign-up stays on this site', async () => {
    const b = new Browser(server.base);
    const out = (await submit(b, { username: 'caa_redirect' }, { next_uri: 'https://evil.example/' })).body.data.caa_registration_homepage_submit;
    assert.strictEqual(out.redirect_uri, '/');
  });

  await t.test('CSRF is enforced on the mutation', async () => {
    const b = new Browser(server.base);
    await b.visit('/accounts/emailsignup/');
    const input = { reg_data: await regData(b, { username: 'csrf_user' }) };
    const res = await b.post('/graphql/query', { fb_api_req_friendly_name: 'useCAARegistrationFormSubmitMutation', variables: { input } }, { csrf: false });
    assert.ok(res.status === 403 || res.status === 400, `status ${res.status}`);
    assert.strictEqual(db.prepare("SELECT 1 FROM users WHERE username_ci = 'csrf_user'").get(), undefined);
  });

  await t.test('field validation answers per field without writing', async () => {
    const b = new Browser(server.base);
    await b.visit('/accounts/emailsignup/');
    const v = async (input) => (await gql(b, 'useCAARegistrationFieldValidationQuery', { input, scale: 1 })).body.data.xfb_caa_registration_field_validation;
    const taken = await v({ field_name: 'USERNAME', fetch_username_suggestions: true, username: sens('caa_user') });
    assert.strictEqual(taken.status, 'VALIDATION_ERROR');
    assert.strictEqual(taken.error.field, 'USERNAME');
    assert.ok(taken.username_suggestions.length > 0);
    assert.strictEqual((await v({ field_name: 'USERNAME', username: sens('free_name_1') })).status, 'SUCCESS');
    assert.strictEqual((await v({ field_name: 'PASSWORD', reg_passwd__: sens('short') })).error.field, 'PASSWORD');
    const ok = await v({ field_name: 'PASSWORD', reg_passwd__: sens(PASSWORD) });
    assert.strictEqual(ok.status, 'SUCCESS');
    // A successful password check must name PASSWORD, or the form re-requests it forever.
    assert.strictEqual(ok.error.field, 'PASSWORD');
    assert.strictEqual(ok.error.message, null);
    assert.strictEqual((await v({ field_name: 'FULLNAME', fullname: sens('A Name') })).status, 'SUCCESS');
    assert.strictEqual(db.prepare("SELECT 1 FROM users WHERE username_ci = 'free_name_1'").get(), undefined);
  });

  await t.test('username typeahead returns free suggestions', async () => {
    const b = new Browser(server.base);
    await b.visit('/accounts/emailsignup/');
    const res = await gql(b, 'useCAARegistrationUsernameTypeaheadQuery', { input: sens('caa_user') });
    const list = res.body.data.xfb_caa_registration_homepage_fetch_username_typeahead.username_suggestions;
    assert.ok(Array.isArray(list) && list.length > 0);
    for (const name of list) assert.strictEqual(db.prepare('SELECT 1 FROM users WHERE username_ci = ?').get(name.toLowerCase()), undefined);
  });

  await t.test('none of the operations is recorded as unsupported', async () => {
    const b = new Browser(server.base);
    const health = (await b.get('/__clone/health')).body.graphql;
    for (const name of ['useCAARegistrationFormSubmitMutation', 'useCAARegistrationFieldValidationQuery', 'useCAARegistrationUsernameTypeaheadQuery']) {
      assert.ok(health.supported.includes(name), name);
    }
    assert.deepStrictEqual(health.unsupported, []);
  });
});
