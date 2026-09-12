import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTwilioCreateOptions,
  normalizePhone,
  normalizeTwilioCreateResult,
  normalizeTwilioStatus,
} from '../src/twilio-adapter.js';

test('Twilio queued/accepted/sending statuses remain provider accepted, not sent', () => {
  assert.equal(normalizeTwilioStatus('queued'), 'accepted');
  assert.equal(normalizeTwilioStatus('accepted'), 'accepted');
  assert.equal(normalizeTwilioStatus('sending'), 'accepted');
  assert.equal(normalizeTwilioStatus('sent'), 'sent');
  assert.equal(normalizeTwilioStatus('delivered'), 'delivered');
  assert.equal(normalizeTwilioStatus('undelivered'), 'failed');
  assert.equal(normalizeTwilioStatus('failed'), 'failed');
});

test('Twilio create result requires a provider Message SID', () => {
  const result = normalizeTwilioCreateResult({ status: 'queued' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.match(result.failureReason, /Message SID/);
});

test('Twilio queued create response is accepted but never claimed sent/delivered', () => {
  const result = normalizeTwilioCreateResult({
    sid: 'SM123',
    status: 'queued',
    errorCode: null,
    dateCreated: new Date('2026-09-12T23:00:00.000Z'),
  });
  assert.equal(result.ok, true);
  assert.equal(result.providerMessageId, 'SM123');
  assert.equal(result.status, 'accepted');
});

test('Twilio undelivered create response is a failure', () => {
  const result = normalizeTwilioCreateResult({
    sid: 'SM456',
    status: 'undelivered',
    errorCode: 30003,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.match(result.failureReason, /30003/);
});

test('Messaging Service is preferred over a From number', () => {
  const options = buildTwilioCreateOptions({
    to: '+18435550199',
    body: 'Owner approved this exact message.',
    statusCallback: 'https://example.com/api/twilio/status',
    messagingServiceSid: 'MG123',
    fromNumber: '+18435550100',
  });
  assert.equal(options.messagingServiceSid, 'MG123');
  assert.equal(options.from, undefined);
});

test('Twilio sender configuration is mandatory', () => {
  assert.throws(() => buildTwilioCreateOptions({
    to: '+18435550199',
    body: 'Message',
    statusCallback: 'https://example.com/api/twilio/status',
  }), /TWILIO_MESSAGING_SERVICE_SID|TWILIO_FROM_NUMBER/);
});

test('phone normalization matches US E.164 and local formatting', () => {
  assert.equal(normalizePhone('+1 (843) 555-0199'), '8435550199');
  assert.equal(normalizePhone('843-555-0199'), '8435550199');
});
