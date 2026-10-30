'use strict';

// These instances were confirmed to expose the standard NIC GePNIC tender UI.
// Keep the URL at the application root; the scraper navigates to the tender list.
const PORTALS = Object.freeze({
  'nic-mp': {
    name: 'Madhya Pradesh',
    url: 'https://mptenders.gov.in/nicgep/app',
  },
  'nic-odisha': {
    name: 'Odisha',
    url: 'https://tendersodisha.gov.in/nicgep/app',
  },
  'nic-chandigarh': {
    name: 'Chandigarh',
    url: 'https://etenders.chd.nic.in/nicgep/app',
  },
  'nic-delhi': {
    name: 'Delhi',
    url: 'https://govtprocurement.delhi.gov.in/nicgep/app',
  },
  'nic-coal': {
    name: 'Coal India',
    url: 'https://coalindiatenders.nic.in/nicgep/app',
  },
  'nic-iocl': {
    name: 'Indian Oil Corporation',
    url: 'https://iocletenders.nic.in/nicgep/app',
  },
  'nic-ntpc': {
    name: 'NTPC',
    url: 'https://eprocurentpc.nic.in/nicgep/app',
  },
  'nic-cpcl': {
    name: 'Chennai Petroleum Corporation',
    url: 'https://cpcletenders.nic.in/nicgep/app',
  },
  'nic-bhel': {
    name: 'BHEL',
    url: 'https://eprocurebhel.co.in/nicgep/app',
  },
});

async function main() {
  const portalId = process.argv[2];
  if (!PORTALS[portalId]) {
    console.error(`Usage: node gepnic.js <${Object.keys(PORTALS).join('|')}>`);
    process.exitCode = 2;
    return;
  }

  // Reuse the same GePNIC extraction flow as TN, with portal-specific identity
  // and origin supplied before loading the scraper module.
  process.env.GEPNIC_PORTAL_ID = portalId;
  process.env.GEPNIC_HOME_URL = PORTALS[portalId].url;
  const TnScraper = require('./tn');
  console.info(`[GePNIC] Starting ${PORTALS[portalId].name} (${portalId})`);
  await new TnScraper().run();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[GePNIC] Unhandled error: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { PORTALS };
