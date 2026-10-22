'use strict';
const path = require('path');
try { require('dotenv').config(); } catch (e) { /* dotenv optional */ }

const root = path.resolve(__dirname, '..');
const isProd = process.env.NODE_ENV === 'production';

const config = {
  root,
  isProd,
  port: parseInt(process.env.PORT || '3000', 10),
  baseUrl: (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''),
  dbPath: process.env.DATABASE_PATH || path.join(root, 'data', 'scentaura.db'),
  uploadDir: process.env.UPLOAD_DIR || path.join(root, 'uploads'),
  sessionSecret: process.env.SESSION_SECRET || '',
  adminSetupToken: process.env.ADMIN_SETUP_TOKEN || '',
  paystack: {
    secretKey: process.env.PAYSTACK_SECRET_KEY || '',
    publicKey: process.env.PAYSTACK_PUBLIC_KEY || '',
    baseUrl: 'https://api.paystack.co'
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || ''
  }
};

config.paystackEnabled = () => !!config.paystack.secretKey;

config.assertProduction = function () {
  const problems = [];
  if (!config.sessionSecret || config.sessionSecret.length < 32) problems.push('SESSION_SECRET must be set to a random value of at least 32 characters.');
  if (!/^https:\/\//.test(config.baseUrl)) problems.push('BASE_URL must start with https:// in production.');
  if (problems.length) {
    throw new Error('Cannot start in production:\n - ' + problems.join('\n - '));
  }
};

module.exports = config;
