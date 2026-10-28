const { sendMessage, sendButtons } = require('./waba');
const store = require('./store');

async function handleWebhook(body) {
  if (!body.entry) return;
  for (const entry of body.entry) {
    for (const change of entry.changes || []) {
      const value = change.value;
      if (!value.messages) continue;
      for (const msg of value.messages) {
        await handleMessage(msg, value.contacts?.[0]);
      }
    }
  }
}

async function handleMessage(msg, contact) {
  const from = msg.from;
  const name = contact?.profile?.name || from;
  console.log('Message from', from, name);

  if (msg.type === 'text') {
    const text = msg.text.body.trim().toLowerCase();
    if (text === 'cobrar' || text === 'start' || text === '/start') {
      await sendMessage(from, '¿Cuánto quieres cobrar?\nEnvía el monto en centavos (1000 = $10.00 MXN)');
      store.conv.set(from, { step: 'amount' });
      return;
    }
    const state = store.conv.get(from);
    if (state?.step === 'amount') {
      const amount = parseInt(text, 10);
      if (!amount || amount <= 0) {
        await sendMessage(from, 'Monto inválido. Envía un número (1000 = $10.00).');
        return;
      }
      const token = store.createInvite(from, amount);
      store.conv.delete(from);
      const formBase = (process.env.PUBLIC_BASE_URL || 'https://pagos.kashbit.bond').replace(/\/$/, '');
      const link = `${formBase}/pay/request/${token}`;
      await sendMessage(from, `Enlace generado:\n${link}\n\nEnvíaselo al pagador.`);
      return;
    }
  }

  if (msg.type === 'interactive') {
    const buttonId = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id;
    console.log('Button:', buttonId);
  }
}

module.exports = { handleWebhook };
