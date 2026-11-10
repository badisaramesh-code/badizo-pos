const printer = document.querySelector('#printer');
const origins = document.querySelector('#origins');
const status = document.querySelector('#status');
const requested = new URLSearchParams(location.hash.slice(1)).get('pos');
let settings;

function announce() {
  if (requested && window.opener && settings.origins.includes(requested)) {
    window.opener.postMessage({ type: 'badizo-printer-ready', printer: settings.printer }, requested);
    status.textContent = 'Connected. Return to billing and leave this printer tab open.';
  }
}

async function load() {
  const response = await fetch('/settings', { headers: { 'X-Badizo-Setup': '1' } });
  if (!response.ok) throw Error('Windows printer settings are unavailable.');
  settings = await response.json();
  printer.add(new Option('Choose a printer', ''));
  for (const name of settings.printers) printer.add(new Option(name, name));
  printer.value = settings.printer || '';
  const addresses = new Set(settings.origins);
  if (requested && /^https?:\/\//.test(requested)) addresses.add(requested);
  origins.value = [...addresses].join('\n');
  document.querySelector('#save').disabled = false;
  status.textContent = settings.printers.length ? 'Review the printer and addresses before saving.' : 'Install the Windows printer and reload this page.';
  announce();
}

document.querySelector('form').onsubmit = async event => {
  event.preventDefault();
  try {
    const next = { printer: printer.value, origins: origins.value.split(/\s+/).filter(Boolean).map(value => new URL(value).origin) };
    const response = await fetch('/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
    if (!response.ok) throw Error(await response.text());
    settings = next;
    status.textContent = 'Printer settings saved for this Windows user.';
    announce();
  } catch (err) { status.textContent = err.message; }
};

window.addEventListener('message', async event => {
  if (!window.opener || event.source !== window.opener || event.origin !== requested ||
      !settings?.origins.includes(event.origin) || event.data?.type !== 'badizo-print-receipt') return;
  const reply = event.ports[0];
  if (!reply) return;
  try {
    if (!(event.data.image instanceof Blob) || event.data.image.type !== 'image/png') throw Error('Invalid receipt.');
    const result = await fetch('/receipt', { method: 'POST', headers: { 'X-Badizo-POS-Origin': event.origin }, body: event.data.image });
    if (!result.ok) throw Error('Printer did not confirm the job.');
    reply.postMessage({ printer: settings.printer });
  } catch (err) { reply.postMessage({ error: err.message }); }
  finally { reply.close(); }
});
load().catch(err => { status.textContent = err.message; });
