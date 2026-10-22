'use strict';
const config = require('../config');
const settings = require('../lib/settings');
const util = require('../lib/util');
const infra = require('../lib/infra');
const orders = require('./orders');

function summary(db, order) {
  const items = orders.getItems(db, order.id);
  const sym = settings.get('currency_symbol', 'GHS', db);
  const lines = items.map(i => `  ${i.qty} x ${i.product_name} (${i.size_label}) – ${util.ghs(i.line_total, sym)}`).join('\n');
  return `${lines}\n\nSubtotal: ${util.ghs(order.subtotal, sym)}\nDiscount: ${util.ghs(order.discount, sym)}\nDelivery: ${util.ghs(order.delivery_fee, sym)}\nTotal: ${util.ghs(order.total, sym)}`;
}

function link(order) { return `${config.baseUrl}/order/${order.order_no}?t=${order.tracking_token}`; }

function fire(p) { Promise.resolve(p).catch(e => console.error('notify failed', e.message)); }

function adminCopy(db, subject, body) {
  const to = settings.get('order_notify_email', '', db) || settings.get('contact_email', '', db);
  if (to) fire(infra.sendMail(to, subject, body, db));
}

function orderPlaced(db, order) {
  const biz = settings.get('business_name', 'Our store', db);
  const body = `Hello ${order.customer_name},\n\nThank you for your order ${order.order_no} with ${biz}.\n\n${summary(db, order)}\n\n` +
    (order.payment_method === 'cod' ? 'You chose to pay on delivery/pickup. We will contact you to confirm your order.\n\n' : 'We will confirm as soon as your payment is received.\n\n') +
    `Track your order: ${link(order)}\n`;
  fire(infra.sendMail(order.customer_email, `Your ${biz} order ${order.order_no}`, body, db));
  adminCopy(db, `New order ${order.order_no}`, `New order from ${order.customer_name} (${order.customer_phone}).\nPayment: ${order.payment_method}\n\n${summary(db, order)}\n`);
}

function orderPaid(db, order) {
  const biz = settings.get('business_name', 'Our store', db);
  fire(infra.sendMail(order.customer_email, `Payment received – ${order.order_no}`,
    `Hello ${order.customer_name},\n\nWe have received your payment for order ${order.order_no}. We are getting it ready.\n\n${summary(db, order)}\n\nTrack your order: ${link(order)}\n\n${biz}`, db));
  adminCopy(db, `PAID: order ${order.order_no}`, `Order ${order.order_no} has been paid.\n\n${summary(db, order)}\n`);
}

function statusChanged(db, order) {
  const biz = settings.get('business_name', 'Our store', db);
  const label = util.ORDER_STATUSES[order.status] || order.status;
  if (!['dispatched', 'out_for_delivery', 'delivered', 'cancelled'].includes(order.status)) return;
  fire(infra.sendMail(order.customer_email, `Order ${order.order_no}: ${label}`,
    `Hello ${order.customer_name},\n\nYour order ${order.order_no} is now: ${label}.\n${order.tracking_no ? 'Tracking number: ' + order.tracking_no + '\n' : ''}\nDetails: ${link(order)}\n\n${biz}`, db));
}

module.exports = { orderPlaced, orderPaid, statusChanged, summary };
