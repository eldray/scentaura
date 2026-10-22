'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchImage, isPrivateAddress } = require('../src/lib/upload');

test('internal and private addresses are recognised', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.9.9', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0'])
    assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('image download refuses unsafe web addresses', async () => {
  for (const u of ['http://example.com/a.jpg', 'https://127.0.0.1/a.jpg', 'https://[::1]/a.jpg', 'https://localhost/a.jpg', 'https://example.com:8443/a.jpg',
    'https://user:pw@example.com/a.jpg', 'file:///etc/passwd', 'not a url', 'https://169.254.169.254/latest/meta-data'])
    await assert.rejects(fetchImage(u), undefined, u);
});
