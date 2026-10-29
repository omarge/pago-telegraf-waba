const crypto = require('crypto');

const invites = new Map();
const requests = new Map();
const conv = new Map();
const cards = new Map();
const pins = new Map();

function newId() {
  return 'KPR-' + crypto.randomBytes(16).toString('hex').toUpperCase();
}

function createInvite(requesterId, amount) {
  const token = crypto.randomBytes(24).toString('base64url');
  invites.set(token, { requesterId, amount, created: Date.now() });
  return token;
}

function consumeInvite(token) {
  const inv = invites.get(token);
  if (!inv) return null;
  invites.delete(token);
  return inv;
}

function createRequest(requesterId, payerId, amount) {
  const id = newId();
  requests.set(id, {
    id,
    requesterId,
    payerId,
    amount,
    state: 'PENDING',
    created: Date.now(),
  });
  return requests.get(id);
}

function getRequest(id) {
  return requests.get(id);
}

function addCard(userId, card) {
  const key = String(userId);
  const list = cards.get(key) || [];
  list.push(card);
  cards.set(key, list);
  return list;
}

function getCards(userId) {
  return cards.get(String(userId)) || [];
}

function setPin(userId, pin) {
  pins.set(String(userId), pin);
}

function getPin(userId) {
  return pins.get(String(userId)) || '1234';
}

module.exports = {
  conv,
  createInvite,
  consumeInvite,
  createRequest,
  getRequest,
  addCard,
  getCards,
  setPin,
  getPin,
};
