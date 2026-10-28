const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createStore } = require('./scripts/durable-store');
const neonStore = require('./scripts/neon-store');
const { createSecureDocuments } = require('./scripts/secure-documents');

const ROOT = __dirname;
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const row of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = row.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
const DEFAULT_PORT = 3001;
const configuredPort = String(process.env.PORT ?? '').trim();
const parsedPort = configuredPort ? Number(configuredPort) : DEFAULT_PORT;
const PORT = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort < 65536
  ? parsedPort
  : DEFAULT_PORT;
if (configuredPort && PORT !== parsedPort) {
  console.warn(`Invalid PORT value (${JSON.stringify(configuredPort)}); using ${DEFAULT_PORT}.`);
}
const MINIMUM_PURCHASE_CENTS = 1_000_000;
const MINIMUM_SELL_CENTS = 1_000_000;
const products = [
  { id: 'au-1oz-eagle', slug: 'american-gold-eagle-1oz', name: 'American Gold Eagle', metal: 'gold', weightOz: 1, purity: '22 karat · 91.67%', type: 'Coin', premiumPct: 0.055, stock: 14, image: 'gold-coin', badge: 'Bestseller' },
  { id: 'au-1oz-bar', slug: 'gold-bar-1oz', name: '1 oz Gold Bar', metal: 'gold', weightOz: 1, purity: '24 karat · 99.99%', type: 'Bar', premiumPct: 0.035, stock: 22, image: 'gold-bar', badge: 'Low premium' },
  { id: 'au-half-eagle', slug: 'american-gold-eagle-half-oz', name: '½ oz Gold Eagle', metal: 'gold', weightOz: 0.5, purity: '22 karat · 91.67%', type: 'Coin', premiumPct: 0.075, stock: 9, image: 'gold-half', badge: 'Fractional' },
  { id: 'ag-10oz-bar', slug: 'silver-bar-10oz', name: '10 oz Silver Bar', metal: 'silver', weightOz: 10, purity: '99.9% fine silver', type: 'Bar', premiumPct: 0.22, stock: 48, image: 'silver-bar', badge: 'Popular' },
  { id: 'ag-1oz-eagle', slug: 'american-silver-eagle-1oz', name: 'American Silver Eagle', metal: 'silver', weightOz: 1, purity: '99.9% fine silver', type: 'Coin', premiumPct: 0.28, stock: 120, image: 'silver-coin', badge: 'Iconic' },
  { id: 'ag-5oz-bar', slug: 'silver-bar-5oz', name: '5 oz Silver Bar', metal: 'silver', weightOz: 5, purity: '99.9% fine silver', type: 'Bar', premiumPct: 0.24, stock: 35, image: 'silver-five', badge: 'Great value' }
];
// Keep the encrypted file store only as a one-time import source when Neon is empty.
// All ongoing application-state writes go to Neon PostgreSQL.
const legacyStore = createStore(ROOT, products);
const secureDocuments = createSecureDocuments(ROOT);
const state = { orders: [], sales: [], users: new Map(), usersById: new Map(), audit: [] };

function applySavedState(savedState) {
  for (const savedProduct of savedState.products || []) {
    const product = products.find(item => item.id === savedProduct.id);
    if (product) {
      if (Number.isInteger(savedProduct.stock) && savedProduct.stock >= 0) product.stock = savedProduct.stock;
      if (Number.isFinite(savedProduct.premiumPct) && savedProduct.premiumPct >= 0 && savedProduct.premiumPct <= 1) product.premiumPct = savedProduct.premiumPct;
      if (typeof savedProduct.name === 'string' && savedProduct.name.length >= 2 && savedProduct.name.length <= 120) product.name = savedProduct.name;
    }
  }
  state.orders = savedState.orders;
  state.sales = savedState.sales;
  state.users = new Map(savedState.users.map(user => [user.email, user]));
  state.usersById = new Map(savedState.users.map(user => [user.id, user]));
  state.audit = savedState.audit;
}

async function initializePersistentState() {
  let savedState = await neonStore.load();
  if (!savedState) {
    const legacyFile = path.join(legacyStore.dataDir, 'store.enc');
    if (fs.existsSync(legacyFile)) {
      console.log('Neon is empty; importing the existing encrypted local application store once.');
      savedState = legacyStore.load();
    } else {
      savedState = { users: [], orders: [], sales: [], audit: [], products };
    }
    applySavedState(savedState);
    await persistState();
    console.log('Initial application state saved to Neon PostgreSQL.');
    return;
  }
  applySavedState(savedState);
  console.log(`Application state loaded from Neon (customers: ${state.users.size}, orders: ${state.orders.length}).`);
}
const quotes = new Map();
const cryptoVerificationLocks = new Set();
const sessions = new Map();
const adminSessions = new Map();
const adminDocumentViews = new Map();
const requestWindows = new Map();
const spot = { gold: 2650.25, silver: 31.18 };
const mockSpot = { ...spot };
let priceSource = 'MOCK PREVIEW DATA';
let priceAsOf = new Date().toISOString();
let lastPriceAttempt = 0;
let priceRefresh = null;
async function refreshSpotPrices(force = false) {
  if (priceRefresh) return priceRefresh;
  if (!force && Date.now() - lastPriceAttempt < 5_000) return;
  lastPriceAttempt = Date.now();
  priceRefresh = (async () => {
    try {
      const getMetal = async symbol => {
        const response = await fetch(`https://api.gold-api.com/price/${symbol}`, { signal: AbortSignal.timeout(7000), headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`Price provider returned ${response.status}`);
        const data = await response.json();
        if (data.symbol !== symbol || data.currency !== 'USD' || !Number.isFinite(Number(data.price)) || Number(data.price) <= 0) throw new Error('Price provider returned invalid data.');
        return data;
      };
      const [gold, silver] = await Promise.all([getMetal('XAU'), getMetal('XAG')]);
      spot.gold = Number(gold.price); spot.silver = Number(silver.price);
      priceSource = 'Gold API · live spot reference';
      priceAsOf = gold.updatedAt || silver.updatedAt || new Date().toISOString();
    } catch {
      spot.gold = mockSpot.gold; spot.silver = mockSpot.silver;
      priceSource = 'MOCK PREVIEW DATA · live feed unavailable';
      priceAsOf = new Date().toISOString();
    }
  })().finally(() => { priceRefresh = null; });
  return priceRefresh;
}
const money = cents => (cents / 100).toFixed(2);
const CRYPTO_WINDOW_MS = 5 * 60_000;
const BTC_CONFIRMATIONS_REQUIRED = 3;
const EVM_CONFIRMATIONS_REQUIRED = 12;
const TRON_RECEIVE_ADDRESS = 'TKT5JSenfCMAAeu9ezhvqeAGievbWBfHqG';
const EVM_RECEIVE_ADDRESS = '0x07e1837af933c566bd1f5d228b47b4cbced4cd57';
const TOKEN_CONFIG = {
  'USDT:ETHEREUM': { chain: 'ETHEREUM', chainId: 1, contract: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6, symbol: 'USDT', networkName: 'Ethereum (ERC-20)' },
  'USDC:ETHEREUM': { chain: 'ETHEREUM', chainId: 1, contract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6, symbol: 'USDC', networkName: 'Ethereum (ERC-20)' },
  'USDT:BSC': { chain: 'BSC', chainId: 56, contract: '0x55d398326f99059ff775485246999027b3197955', decimals: 18, symbol: 'USDT', networkName: 'BNB Smart Chain (BEP-20)' },
  'USDT:TRON': { chain: 'TRON', contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6, symbol: 'USDT', networkName: 'TRON (TRC-20)' },
};
const TRANSFER_EVENT_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
function selectedToken(asset, network) { return TOKEN_CONFIG[`${asset}:${network}`] || null; }
function decodeTronAddress(address) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  if (typeof address !== 'string' || !address.startsWith('T')) return null;
  let value = 0n;
  for (const char of address) { const digit = alphabet.indexOf(char); if (digit < 0) return null; value = value * 58n + BigInt(digit); }
  let hex = value.toString(16).padStart(50, '0');
  let bytes = Buffer.from(hex, 'hex');
  if (bytes.length !== 25 || bytes[0] !== 0x41) return null;
  const payload = bytes.subarray(0, 21); const checksum = crypto.createHash('sha256').update(crypto.createHash('sha256').update(payload).digest()).digest().subarray(0, 4);
  if (!crypto.timingSafeEqual(checksum, bytes.subarray(21))) return null;
  return payload.subarray(1).toString('hex').toLowerCase();
}
function amountUnitsFromCents(cents, decimals) { return ((BigInt(cents) * (10n ** BigInt(decimals))) / 100n).toString(); }
function formatTokenUnits(units, decimals) { const raw = BigInt(units); const scale = 10n ** BigInt(decimals); const fraction = (raw % scale).toString().padStart(decimals, '0').replace(/0+$/, ''); return `${raw / scale}${fraction ? `.${fraction}` : ''}`; }
function evmAddressTopic(address) { return `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`; }
async function evmExplorerRequest(chainId, params) {
  const key = String(process.env.ETHERSCAN_API_KEY || '').trim();
  if (!key) throw new Error('ETHERSCAN_API_KEY is not configured.');
  const url = new URL('https://api.etherscan.io/v2/api');
  url.searchParams.set('chainid', String(chainId));
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
  url.searchParams.set('apikey', key);
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Etherscan returned ${response.status}.`);
  const data = await response.json();
  if (data.status === '0' && data.message !== 'OK') throw new Error('Etherscan could not verify this transaction.');
  return data.result;
}
async function verifyEvmStablecoin(order, txHash) {
  const payment = order.cryptoPayment;
  const [receipt, blockHex] = await Promise.all([
    evmExplorerRequest(payment.chainId, { module: 'proxy', action: 'eth_getTransactionReceipt', txhash: txHash }),
    evmExplorerRequest(payment.chainId, { module: 'proxy', action: 'eth_blockNumber' }),
  ]);
  if (!receipt || !Array.isArray(receipt.logs) || String(receipt.status).toLowerCase() !== '0x1') return { found: false, error: 'No successful on-chain transaction receipt was found.' };
  const expectedContract = payment.tokenContract.toLowerCase(); const expectedRecipient = evmAddressTopic(payment.address).toLowerCase();
  const log = receipt.logs.find(entry => String(entry.address).toLowerCase() === expectedContract && String(entry.topics?.[0]).toLowerCase() === `0x${TRANSFER_EVENT_TOPIC}` && String(entry.topics?.[2]).toLowerCase() === expectedRecipient);
  if (!log || !/^0x[0-9a-f]+$/i.test(String(log.data))) return { found: false, error: `The transaction did not transfer the selected ${payment.asset} contract to the configured receiving address.` };
  const receivedUnits = BigInt(log.data).toString();
  if (BigInt(receivedUnits) < BigInt(payment.amountUnits)) return { found: false, error: `The ${payment.asset} transfer is below the required invoice amount.` };
  const blockNumber = Number(BigInt(receipt.blockNumber || '0x0'));
  const currentBlock = Number(BigInt(blockHex || '0x0'));
  const confirmations = blockNumber > 0 && currentBlock >= blockNumber ? currentBlock - blockNumber + 1 : 0;
  let block = null;
  if (blockNumber > 0) block = await evmExplorerRequest(payment.chainId, { module: 'proxy', action: 'eth_getBlockByNumber', tag: `0x${blockNumber.toString(16)}`, boolean: 'false' });
  const txTime = Number(BigInt(block?.timestamp || '0x0')) * 1000;
  const start = new Date(order.createdAt).getTime(); const expires = new Date(payment.expiresAt).getTime();
  if (!txTime || txTime < start - 60_000 || txTime > expires) return { found: false, error: 'The transfer was mined outside this invoice payment window.' };
  return { found: true, receivedUnits, confirmations, txTime, blockNumber };
}
async function verifyTronUsdt(order, txId) {
  const apiKey = String(process.env.TRONGRID_API_KEY || '').trim();
  if (!apiKey) throw new Error('TRONGRID_API_KEY is not configured.');
  const response = await fetch('https://api.trongrid.io/walletsolidity/gettransactioninfobyid', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'TRON-PRO-API-KEY': apiKey }, body: JSON.stringify({ value: txId }), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`TronGrid returned ${response.status}.`);
  const receipt = await response.json();
  if (String(receipt.id || '').toLowerCase() !== txId || !Number(receipt.blockNumber) || receipt.receipt?.result !== 'SUCCESS') return { found: false, error: 'TronGrid did not find a successful, solidified TRON transaction.' };
  const expectedAddressHex = decodeTronAddress(order.cryptoPayment.address);
  const expectedContractHex = decodeTronAddress(order.cryptoPayment.tokenContract);
  if (!expectedAddressHex || !expectedContractHex) throw new Error('Configured TRON receiving or token contract address is invalid.');
  const transfer = (Array.isArray(receipt.log) ? receipt.log : []).find(entry => String(entry.address || '').replace(/^41/i, '').toLowerCase() === expectedContractHex && String(entry.topics?.[0] || '').toLowerCase() === TRANSFER_EVENT_TOPIC && String(entry.topics?.[2] || '').slice(-40).toLowerCase() === expectedAddressHex);
  if (!transfer || !/^[0-9a-f]{64}$/i.test(String(transfer.data || ''))) return { found: false, error: 'The transaction did not transfer TRC-20 USDT to the configured receiving address.' };
  const receivedUnits = BigInt(`0x${transfer.data}`).toString();
  if (BigInt(receivedUnits) < BigInt(order.cryptoPayment.amountUnits)) return { found: false, error: 'The TRC-20 USDT transfer is below the required invoice amount.' };
  const txTime = Number(receipt.blockTimeStamp || 0);
  const start = new Date(order.createdAt).getTime(); const expires = new Date(order.cryptoPayment.expiresAt).getTime();
  if (!txTime || txTime < start - 60_000 || txTime > expires) return { found: false, error: 'The TRON transfer was confirmed outside this invoice payment window.' };
  return { found: true, receivedUnits, confirmations: 1, txTime, blockNumber: Number(receipt.blockNumber) };
}
function validBitcoinAddress(address) { return /^(bc1)[ac-hj-np-z02-9]{11,71}$/i.test(address) || /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address); }
async function blockchainRequest(pathname, body = null) {
  const headers = { Accept: 'application/json' };
  if (process.env.BLOCKCHAIN_EXPLORER_API_KEY) headers['X-Explorer-Auth-Key'] = process.env.BLOCKCHAIN_EXPLORER_API_KEY;
  const response = await fetch(`https://api.blockchain.info/explorer-gateway-kt${pathname}`, { method: body ? 'POST' : 'GET', headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Blockchain.com Explorer returned ${response.status}.`);
  return response.json();
}
async function getBitcoinUsdSellRate() {
  const response = await fetch('https://blockchain.info/ticker', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Blockchain.com exchange-rate service returned ${response.status}.`);
  const rates = await response.json();
  const rate = Number(rates.USD?.sell);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('Blockchain.com returned an invalid BTC/USD rate.');
  return rate;
}

const COUNTRY_CURRENCY_GROUPS = {
  USD: ['United States Minor Outlying Islands','British Indian Ocean Territory','United States','United States of America','USA','US','Ecuador','El Salvador','Panama','Timor-Leste','Marshall Islands','Micronesia','Palau','British Virgin Islands','Turks and Caicos Islands','Bonaire','Puerto Rico','Guam','American Samoa','Northern Mariana Islands','United States Virgin Islands','US Virgin Islands','Federated States of Micronesia','Micronesia, Federated States of','Virgin Islands, U.S.','Virgin Islands, British'],
  NGN: ['Nigeria','NG'],
  GBP: ['Saint Helena, Ascension and Tristan da Cunha','South Georgia and the South Sandwich Islands','Guernsey','Isle of Man','Jersey','United Kingdom','UK','Great Britain','England','Scotland','Wales','Northern Ireland','GB'],
  EUR: ['Åland Islands','Aland Islands','Saint Barthélemy','Saint Barthelemy','Saint Martin (French part)','Saint Pierre and Miquelon','French Southern Territories','Macao','Germany','France','Italy','Spain','Portugal','Netherlands','Belgium','Austria','Ireland','Finland','Greece','Luxembourg','Malta','Cyprus','Estonia','Latvia','Lithuania','Slovakia','Slovenia','Croatia','Andorra','Monaco','San Marino','Vatican City','Holy See (Vatican City State)','Montenegro','Kosovo','French Guiana','Guadeloupe','Martinique','Mayotte','Réunion','Reunion','Saint Martin'],
  CAD: ['Canada','CA'], AUD: ['Australia','AU','Heard Island and McDonald Islands','Christmas Island','Cocos (Keeling) Islands','Cocos Islands','Norfolk Island','Kiribati','Nauru','Tuvalu'],
  NZD: ['New Zealand','NZ','Cook Islands','Niue','Pitcairn Islands','Pitcairn','Tokelau'],
  INR: ['India','IN'], SAR: ['Saudi Arabia','SA'], AED: ['United Arab Emirates','UAE','AE'], SGD: ['Singapore','SG'],
  JPY: ['Japan','JP'], CNY: ['China','CN'], HKD: ['Hong Kong','HK'], TWD: ['Taiwan','TW'], KRW: ['South Korea','Korea, Republic of','KR'], KPW: ['North Korea'],
  CHF: ['Switzerland','CH','Liechtenstein'], SEK: ['Sweden','SE'], NOK: ['Norway','NO','Svalbard and Jan Mayen','Bouvet Island'], DKK: ['Denmark','DK','Greenland','Faroe Islands'], ISK: ['Iceland','IS'],
  BRL: ['Brazil','BR'], MXN: ['Mexico','MX'], ARS: ['Argentina','AR'], CLP: ['Chile','CL'], COP: ['Colombia','CO'], PEN: ['Peru','PE'], UYU: ['Uruguay','UY'], PYG: ['Paraguay','PY'], BOB: ['Bolivia','BO'], VES: ['Venezuela','VE'],
  ZAR: ['South Africa','ZA'], KES: ['Kenya','KE'], GHS: ['Ghana','GH'], EGP: ['Egypt','EG'], MAD: ['Morocco','MA','Western Sahara'], TND: ['Tunisia','TN'], DZD: ['Algeria','DZ'], ETB: ['Ethiopia','ET'], UGX: ['Uganda','UG'], TZS: ['Tanzania','TZ'], RWF: ['Rwanda','RW'], XOF: ['Senegal','SN','Ivory Coast','Côte d’Ivoire','Cote d Ivoire','Burkina Faso','Mali','Niger','Togo','Benin','Guinea-Bissau'], XAF: ['Cameroon','CM','Central African Republic','Chad','Republic of the Congo','Congo','Gabon','Equatorial Guinea'], BWP: ['Botswana','BW'], ZMW: ['Zambia','ZM'], MWK: ['Malawi','MW'], ZWL: ['Zimbabwe','ZW'], NAD: ['Namibia','NA'], AOA: ['Angola','AO'], MZN: ['Mozambique','MZ'], MGA: ['Madagascar','MG'], MUR: ['Mauritius','MU'], SCR: ['Seychelles','SC'], SDG: ['Sudan','SD'], SSP: ['South Sudan','SS'], SOS: ['Somalia','SO'], GMD: ['Gambia','GM'], GNF: ['Guinea','GN'], SLL: ['Sierra Leone','SL'], LRD: ['Liberia','LR'], CDF: ['Democratic Republic of the Congo','Congo, The Democratic Republic of the','DR Congo','CD'], BIF: ['Burundi','BI'], LSL: ['Lesotho','LS'], CVE: ['Cape Verde','Cabo Verde','CV'], KMF: ['Comoros','KM'], STN: ['Sao Tome and Principe','São Tomé and Príncipe','ST'], ERN: ['Eritrea','ER'], DJF: ['Djibouti','DJ'], MRU: ['Mauritania','MR'], LYD: ['Libya','LY'], SZL: ['Eswatini','Swaziland','SZ'],
  PKR: ['Pakistan','PK'], BDT: ['Bangladesh','BD'], LKR: ['Sri Lanka','LK'], NPR: ['Nepal','NP'], BTN: ['Bhutan','BT'], AFN: ['Afghanistan','AF'], IRR: ['Iran','IR'], IQD: ['Iraq','IQ'], ILS: ['Israel','IL','Palestine','Palestine, State of','Palestinian Territories'], LBP: ['Lebanon','LB'], SYP: ['Syria','Syrian Arab Republic','SY'], JOD: ['Jordan','JO'], KWD: ['Kuwait','KW'], BHD: ['Bahrain','BH'], QAR: ['Qatar','QA'], OMR: ['Oman','OM'], YER: ['Yemen','YE'], TRY: ['Turkey','Türkiye','TR'], AZN: ['Azerbaijan','AZ'], GEL: ['Georgia','GE'], AMD: ['Armenia','AM'], ALL: ['Albania','AL'], RSD: ['Serbia','RS'], BAM: ['Bosnia and Herzegovina','BA'], MKD: ['North Macedonia','Macedonia','MK'], MDL: ['Moldova','MD'], UAH: ['Ukraine','UA'], RUB: ['Russia','Russian Federation','RU'], BYN: ['Belarus','BY'], PLN: ['Poland','PL'], CZK: ['Czechia','Czech Republic','CZ'], HUF: ['Hungary','HU'], RON: ['Romania','RO'], BGN: ['Bulgaria','BG'], KZT: ['Kazakhstan','KZ'], UZS: ['Uzbekistan','UZ'], KGS: ['Kyrgyzstan','KG'], TJS: ['Tajikistan','TJ'], TMT: ['Turkmenistan','TM'], MNT: ['Mongolia','MN'],
  THB: ['Thailand','TH'], VND: ['Vietnam','Viet Nam','VN'], IDR: ['Indonesia','ID'], MYR: ['Malaysia','MY'], PHP: ['Philippines','PH'], PKR: ['Pakistan','PK'], MMK: ['Myanmar','Burma','MM'], KHR: ['Cambodia','KH'], LAK: ['Laos','Lao PDR','LA'], BND: ['Brunei','Brunei Darussalam','BN'], FJD: ['Fiji','FJ'], PGK: ['Papua New Guinea','PG'], SBD: ['Solomon Islands','SB'], TOP: ['Tonga','TO'], VUV: ['Vanuatu','VU'], WST: ['Samoa','WS'],
  CRC: ['Costa Rica','CR'], GTQ: ['Guatemala','GT'], HNL: ['Honduras','HN'], NIO: ['Nicaragua','NI'], DOP: ['Dominican Republic','DO'], JMD: ['Jamaica','JM'], TTD: ['Trinidad and Tobago','TT'], BBD: ['Barbados','BB'], BSD: ['Bahamas','BS'], BZD: ['Belize','BZ'], XCD: ['Antigua and Barbuda','Dominica','Grenada','Saint Kitts and Nevis','Saint Lucia','Saint Vincent and the Grenadines','Anguilla','Montserrat'],
  XPF: ['French Polynesia','New Caledonia','Wallis and Futuna'],
  BMD: ['Bermuda','BM'], KYD: ['Cayman Islands','KY'], AWG: ['Aruba','AW'], ANG: ['Curaçao','Curacao','Sint Maarten','Sint Maarten (Dutch part)','Bonaire, Sint Eustatius and Saba'], SRD: ['Suriname','SR'], GYD: ['Guyana','GY'], HTG: ['Haiti','HT'], CUP: ['Cuba','CU'], MVR: ['Maldives','MV'], OMR: ['Oman','OM'], FKP: ['Falkland Islands','Falkland Islands (Malvinas)','FK'], IMP: ['Isle of Man'], JEP: ['Jersey'], GIP: ['Gibraltar','GI'], SHP: ['Saint Helena'], BND: ['Brunei','Brunei Darussalam','BN']
};
const COUNTRY_CURRENCY = new Map();
for (const [currency, countries] of Object.entries(COUNTRY_CURRENCY_GROUPS)) for (const country of countries) COUNTRY_CURRENCY.set(country.normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ''), currency);
function localCurrencyForCountry(country) {
  const key = String(country || '').normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return COUNTRY_CURRENCY.get(key) || (key ? null : 'USD');
}

let usdRatesCache = { rates: null, source: null, expiresAt: 0 };
async function getUsdLocalRate(currency) {
  if (currency === 'NGN') {
    const configured = Number(process.env.USD_NGN_RATE);
    if (Number.isFinite(configured) && configured > 0) return { rate: configured, source: 'Configured USD_NGN_RATE' };
  }
  if (!usdRatesCache.rates || usdRatesCache.expiresAt <= Date.now()) {
    const response = await fetch('https://open.er-api.com/v6/latest/USD', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error('The live currency-rate service is unavailable. Try again later.');
    const data = await response.json();
    if (data?.result !== 'success' || !data?.rates || typeof data.rates !== 'object') throw new Error('The currency-rate service returned invalid data.');
    usdRatesCache = { rates: data.rates, source: 'Live reference rate', expiresAt: Date.now() + 15 * 60_000 };
  }
  const rate = Number(usdRatesCache.rates[currency]);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`A live USD/${currency} exchange rate is unavailable.`);
  return { rate, source: usdRatesCache.source };
}
function currencyName(currency) {
  if (!currency) return 'Local currency not mapped';
  try { return new Intl.DisplayNames(['en'], { type: 'currency' }).of(currency) || currency; } catch { return currency; }
}
function walletTx(user, id) { return (user.walletTransactions || []).find(tx => tx.id === id); }
function ensureWallet(user) { if (!Number.isSafeInteger(user.walletBalanceCents) || user.walletBalanceCents < 0) user.walletBalanceCents = 0; if (!Array.isArray(user.walletTransactions)) user.walletTransactions = []; }
function pricing(p) {
  const spotCents = Math.round(spot[p.metal] * p.weightOz * 100);
  const premiumCents = Math.round(spotCents * p.premiumPct);
  const priceCents = spotCents + premiumCents;
  return { ...p, spotCents, premiumCents, priceCents, spotPrice: money(spotCents), premium: money(premiumCents), price: money(priceCents) };
}
function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}
async function persistState() {
  await neonStore.save({
    users: [...state.users.values()],
    orders: state.orders,
    sales: state.sales,
    audit: state.audit.slice(-10_000),
    products,
  });
}
async function log(action, detail) {
  state.audit.push({ at: new Date().toISOString(), action, detail });
  await persistState();
}
async function releaseExpiredCryptoReservations() {
  const now = Date.now(); let changed = false;
  for (const order of state.orders) {
    const payment = order.cryptoPayment;
    if (!payment?.inventoryReserved || order.paymentStatus === 'paid' || order.paymentStatus === 'pending_admin_review') continue;
    const releaseAt = payment.txId ? new Date(payment.confirmationDeadlineAt || 0).getTime() : new Date(payment.expiresAt).getTime();
    if (!Number.isFinite(releaseAt) || releaseAt > now) continue;
    for (const line of order.lines || []) { const product = products.find(item => item.id === line.productId); if (product) product.stock += line.quantity; }
    payment.inventoryReserved = false; payment.status = 'expired'; order.paymentStatus = 'expired'; order.status = 'expired'; changed = true;
    state.audit.push({ at: new Date().toISOString(), action: 'crypto_payment_expired', detail: { orderId: order.id, hadSubmittedTx: Boolean(payment.txId) } });
  }
  if (changed) await persistState();
}
function adminTokenFromRequest(req) {
  const authorization = String(req.headers.authorization || '');
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}
function adminAuthorized(req) {
  const token = adminTokenFromRequest(req);
  const session = token && adminSessions.get(token);
  if (!session || session.expiresAt <= Date.now()) { if (token) adminSessions.delete(token); return false; }
  return true;
}
function cookieSession(req) {
  const cookies = String(req.headers.cookie || '').split(';').map(v => v.trim());
  const token = cookies.find(v => v.startsWith('gi_session='))?.slice('gi_session='.length);
  const session = token && sessions.get(token);
  if (!session || session.expiresAt < Date.now()) { if (token) sessions.delete(token); return null; }
  return { token, user: state.usersById.get(session.userId) || null };
}
function hitRateLimit(req, bucket, limit, windowMs) {
  const key = `${bucket}:${req.socket.remoteAddress || 'unknown'}`;
  const now = Date.now();
  let entry = requestWindows.get(key);
  if (!entry || entry.resetAt <= now) entry = { count: 0, resetAt: now + windowMs };
  entry.count += 1;
  requestWindows.set(key, entry);
  if (requestWindows.size > 5000) for (const [storedKey, value] of requestWindows) if (value.resetAt <= now) requestWindows.delete(storedKey);
  return entry.count > limit ? Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) : 0;
}
function createOneTimeToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: crypto.createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() };
}
function validTokenRecord(record, token) {
  if (!record || !token || new Date(record.expiresAt).getTime() <= Date.now()) return false;
  const supplied = crypto.createHash('sha256').update(String(token)).digest();
  const expected = Buffer.from(String(record.hash || ''), 'hex');
  return expected.length === supplied.length && crypto.timingSafeEqual(supplied, expected);
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return { salt: salt.toString('hex'), passwordHash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function passwordMatches(user, password) {
  if (!user || !user.salt || !user.passwordHash || password.length > 200) return false;
  const candidate = crypto.scryptSync(password, Buffer.from(user.salt, 'hex'), 64);
  const expected = Buffer.from(user.passwordHash, 'hex');
  return expected.length === candidate.length && crypto.timingSafeEqual(candidate, expected);
}
function publicUser(user) { return user && ({ id: user.id, name: user.name, firstName: user.firstName || user.name?.split(' ')[0] || '', lastName: user.lastName || user.name?.split(' ').slice(1).join(' ') || '', email: user.email, emailVerified: user.emailVerified !== false, phone: user.phone || '', country: user.country, address: user.address, city: user.city, region: user.region, postalCode: user.postalCode, verificationStatus: user.verificationStatus || 'not_started', verificationSubmittedAt: user.verificationSubmittedAt || null, verificationReviewedAt: user.verificationReviewedAt || null, verificationDocumentType: user.verificationDocumentType || null, verificationMethod: user.verificationMethod || null, manualDocumentReviewAt: user.manualDocumentReviewAt || null, verificationDocumentCount: (user.verificationDocuments || []).length, accountDeletionRequestedAt: user.accountDeletionRequestedAt || null, identityVerified: user.verificationStatus === 'verified' && (user.identityProviderVerified === true || user.verificationMethod === 'manual_admin_review'), createdAt: user.createdAt }); }
function purchaseVerificationApproved(user) {
  if (!user || user.verificationStatus !== 'verified') return false;
  const trustedProviderApproved = process.env.IDENTITY_PROVIDER_ENABLED === 'true' && user.identityProviderVerified === true;
  const adminManuallyApproved = user.verificationMethod === 'manual_admin_review' && Boolean(user.manualDocumentReviewAt) && Boolean(user.verificationReviewedAt);
  return trustedProviderApproved || adminManuallyApproved;
}
function sessionCookie(token, req, maxAge = 60 * 60 * 24 * 7) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `gi_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}
async function body(req, maxBytes = 16_384) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > maxBytes) throw new Error('Request is too large.'); }
  try { return JSON.parse(raw || '{}'); } catch { throw new Error('Request body must be valid JSON.'); }
}
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
function serveFile(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const publicRoot = fs.existsSync(path.join(ROOT, 'dist')) ? path.join(ROOT, 'dist') : ROOT;
  const file = path.resolve(publicRoot, relative);
  if (!file.startsWith(path.resolve(publicRoot) + path.sep)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, content) => {
    if (err && path.extname(file)) return send(res, 404, { error: 'Not found' });
    if (err) return fs.readFile(path.join(publicRoot, 'index.html'), (fallbackErr, fallback) => {
      if (fallbackErr) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': mime['.html'], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
      res.end(fallback);
    });
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    res.end(content);
  });
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: https://i.pinimg.com https://images.pexels.com https://thumb.wikimedia.org https://upload.wikimedia.org; media-src 'self' blob: https://v1.pinimg.com; style-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://cdn.jsdelivr.net https://storage.googleapis.com https://countriesnow.space; worker-src 'self' blob:; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'POST' && ['/api/auth/login', '/api/auth/signup', '/api/admin/login'].includes(url.pathname)) {
      const retryAfter = hitRateLimit(req, url.pathname, url.pathname.endsWith('/login') ? 8 : 5, 15 * 60_000);
      if (retryAfter) return send(res, 429, { error: 'Too many attempts. Wait a few minutes and try again.' }, { 'Retry-After': String(retryAfter) });
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/login') {
      const input = await body(req);
      const email = String(input.email || '').trim().toLowerCase();
      const password = String(input.password || '');
      const configuredEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
      const saltHex = process.env.ADMIN_PASSWORD_SALT || '';
      const hashHex = process.env.ADMIN_PASSWORD_HASH || '';
      if (!configuredEmail || !/^[0-9a-f]{32,}$/i.test(saltHex) || !/^[0-9a-f]{128}$/i.test(hashHex)) return send(res, 503, { error: 'Admin email and password are not configured on the server.' });
      if (password.length > 200) return send(res, 401, { error: 'Admin email or password is incorrect.' });
      const candidate = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
      const expected = Buffer.from(hashHex, 'hex');
      if (email !== configuredEmail || !crypto.timingSafeEqual(candidate, expected)) return send(res, 401, { error: 'Admin email or password is incorrect.' });
      const token = crypto.randomBytes(32).toString('base64url');
      adminSessions.set(token, { email, expiresAt: Date.now() + 8 * 60 * 60_000 });
      await log('admin_login_preview', { email });
      return send(res, 200, { token, expiresInSeconds: 8 * 60 * 60 }, { 'Cache-Control': 'no-store' });
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/logout') {
      const token = adminTokenFromRequest(req);
      if (token) adminSessions.delete(token);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, mode: 'preview', pricingSource: 'mock' });
    if (req.method === 'GET' && url.pathname === '/api/auth/me') return send(res, 200, { user: publicUser(cookieSession(req)?.user || null) });
    if (req.method === 'GET' && url.pathname === '/api/account/checkout-profile') {
      const user = cookieSession(req)?.user;
      if (!user) return send(res, 401, { error: 'Sign in to load your saved checkout details.' });
      const identityVerified = publicUser(user).identityVerified;
      return send(res, 200, { customer: publicUser(user), identityVerified });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/signup') {
      const retryAfter = hitRateLimit(req, 'signup', 5, 60 * 60_000);
      if (retryAfter) return send(res, 429, { error: `Too many registration attempts. Try again in ${retryAfter} seconds.` }, { 'Retry-After': String(retryAfter) });
      const input = await body(req);
      const firstName = String(input.firstName || '').trim(); const lastName = String(input.lastName || '').trim(); const name = `${firstName} ${lastName}`.trim(); const email = String(input.email || '').trim().toLowerCase();
      const country = String(input.country || '').trim(); const address = String(input.address || '').trim();
      const city = String(input.city || '').trim(); const region = String(input.region || '').trim();
      const postalCode = String(input.postalCode || '').trim(); const password = String(input.password || ''); const confirmPassword = String(input.confirmPassword || '');
      if (password !== confirmPassword) return send(res, 400, { error: 'Passwords do not match. Please check both fields.' });
      if (firstName.length < 1 || firstName.length > 80 || lastName.length < 1 || lastName.length > 80 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || country.length < 2 || country.length > 80 || address.length < 5 || address.length > 250 || city.length < 2 || city.length > 100 || region.length > 100 || postalCode.length > 24 || password.length < 12 || password.length > 200) return send(res, 400, { error: 'Enter valid account details and a password of at least 12 characters.' });
      if (state.users.has(email)) return send(res, 409, { error: 'An account with this email already exists. Sign in or request a verification email.' });
      if (!process.env.SECURESMTP_API_KEY) return send(res, 503, { error: 'Email verification is temporarily unavailable. Please try again later.' });
      const credentials = hashPassword(password);
      const verification = createOneTimeToken();
      const user = { id: crypto.randomUUID(), name, firstName, lastName, email, phone: '', country, address, city, region, postalCode, emailVerified: false, emailVerificationTokenHash: verification.hash, emailVerificationExpiresAt: verification.expiresAt, verificationStatus: 'not_started', ...credentials, createdAt: new Date().toISOString() };
      state.users.set(email, user); state.usersById.set(user.id, user);
      try {
        const { sendVerificationEmail } = require('./services/email');
        const result = await sendVerificationEmail({ to: user.email, firstName: user.firstName, token: verification.token });
        if (result?.skipped) throw new Error(result.reason || 'Email service not configured');
        await log('customer_signup_verification_sent', { userId: user.id });
      } catch (emailError) {
        state.users.delete(email); state.usersById.delete(user.id);
        await persistState();
        console.error('Verification email failed for new customer:', user.id, emailError.message);
        return send(res, 502, { error: 'We could not send your verification email. Check the address or try again shortly.' });
      }
      await persistState();
      return send(res, 201, { verificationRequired: true, email: user.email, message: 'Account created. Check your email and click the verification link before signing in.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const retryAfter = hitRateLimit(req, 'login', 8, 15 * 60_000);
      if (retryAfter) return send(res, 429, { error: `Too many sign-in attempts. Try again in ${retryAfter} seconds.` }, { 'Retry-After': String(retryAfter) });
      const input = await body(req); const email = String(input.email || '').trim().toLowerCase(); const password = String(input.password || '');
      const user = state.users.get(email);
      if (!user || !passwordMatches(user, password)) return send(res, 401, { error: 'Email or password is incorrect.' });
      // Legacy accounts created before email verification existed remain accessible; all new accounts must verify.
      if (user.emailVerified === false) return send(res, 403, { error: 'Please verify your email before signing in. You can request a new verification link.' , verificationRequired: true, email: user.email });
      const token = crypto.randomBytes(32).toString('base64url'); sessions.set(token, { userId: user.id, expiresAt: Date.now() + 7 * 86400_000 });
      await log('customer_login', { userId: user.id });
      return send(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(token, req) });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/resend-verification') {
      const retryAfter = hitRateLimit(req, 'resend-verification', 3, 60 * 60_000);
      if (retryAfter) return send(res, 429, { error: `Please wait ${retryAfter} seconds before requesting another email.` }, { 'Retry-After': String(retryAfter) });
      const input = await body(req); const email = String(input.email || '').trim().toLowerCase(); const user = state.users.get(email);
      if (!user || user.emailVerified !== false) return send(res, 200, { message: 'If an unverified account exists for that address, a verification email has been sent.' });
      if (!process.env.SECURESMTP_API_KEY) return send(res, 503, { error: 'Email verification is temporarily unavailable. Please try again later.' });
      const verification = createOneTimeToken(); user.emailVerificationTokenHash = verification.hash; user.emailVerificationExpiresAt = verification.expiresAt;
      try { const { sendVerificationEmail } = require('./services/email'); const result = await sendVerificationEmail({ to: user.email, firstName: user.firstName, token: verification.token }); if (result?.skipped) throw new Error(result.reason); await persistState(); }
      catch (error) { console.error('SecureSMTP verification email failed:', error.message); return send(res, 502, { error: 'We could not send a verification email. Please try again later.' }); }
      return send(res, 200, { message: 'A new verification link has been sent if the account is eligible.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/verify-email') {
      const input = await body(req); const token = String(input.token || ''); const purpose = String(input.purpose || 'signup');
      if (!token || token.length > 200) return send(res, 400, { error: 'This verification link is invalid or expired. Request a new one.' });
      if (purpose === 'email-change') {
        const user = [...state.users.values()].find(item => validTokenRecord(item.pendingEmailVerification, token));
        if (!user) return send(res, 400, { error: 'This verification link is invalid or expired. Request a new one.' });
        const newEmail = user.pendingEmailVerification.email;
        if (state.users.has(newEmail)) return send(res, 409, { error: 'That email address is already connected to another account.' });
        const oldEmail = user.email; state.users.delete(oldEmail); user.email = newEmail; user.emailVerified = true; delete user.pendingEmailVerification; state.users.set(newEmail, user);
        for (const order of state.orders) if (order.customer?.email === oldEmail) order.customer.email = newEmail;
        for (const sale of state.sales) if (sale.customer?.email === oldEmail) sale.customer.email = newEmail;
        for (const [sessionToken, activeSession] of sessions) if (activeSession.userId === user.id) sessions.delete(sessionToken);
        await log('customer_email_changed', { userId: user.id });
        return send(res, 200, { message: 'Your email address has been updated and verified. Please sign in again.' }, { 'Set-Cookie': sessionCookie('', req, 0) });
      }
      const user = [...state.users.values()].find(item => item.emailVerified === false && validTokenRecord({ hash: item.emailVerificationTokenHash, expiresAt: item.emailVerificationExpiresAt }, token));
      if (!user) return send(res, 400, { error: 'This verification link is invalid, expired, or already used. Request a new one.' });
      user.emailVerified = true; delete user.emailVerificationTokenHash; delete user.emailVerificationExpiresAt;
      await log('customer_email_verified', { userId: user.id });
      return send(res, 200, { message: 'Email verified successfully. You can now sign in.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/forgot-password') {
      const retryAfter = hitRateLimit(req, 'forgot-password', 3, 60 * 60_000);
      if (retryAfter) return send(res, 429, { error: `Please wait ${retryAfter} seconds before requesting another reset email.` }, { 'Retry-After': String(retryAfter) });
      const input = await body(req); const email = String(input.email || '').trim().toLowerCase(); const user = state.users.get(email);
      const generic = 'If an account exists for that address, a password reset email has been sent.';
      if (!user) return send(res, 200, { message: generic });
      if (!process.env.SECURESMTP_API_KEY) return send(res, 503, { error: 'Password reset email is temporarily unavailable. Please try again later.' });
      const reset = createOneTimeToken(); user.passwordResetTokenHash = reset.hash; user.passwordResetExpiresAt = reset.expiresAt;
      try { const { sendPasswordResetEmail } = require('./services/email'); const result = await sendPasswordResetEmail({ to: user.email, firstName: user.firstName, token: reset.token }); if (result?.skipped) throw new Error(result.reason); await persistState(); }
      catch (error) { console.error('Password reset email failed:', error.message); return send(res, 502, { error: 'We could not send a reset email. Please try again later.' }); }
      return send(res, 200, { message: generic });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/reset-password') {
      const input = await body(req); const token = String(input.token || ''); const password = String(input.password || ''); const confirmPassword = String(input.confirmPassword || '');
      if (password !== confirmPassword) return send(res, 400, { error: 'Passwords do not match.' });
      if (password.length < 12 || password.length > 200) return send(res, 400, { error: 'Choose a password between 12 and 200 characters.' });
      const user = [...state.users.values()].find(item => validTokenRecord({ hash: item.passwordResetTokenHash, expiresAt: item.passwordResetExpiresAt }, token));
      if (!user) return send(res, 400, { error: 'This reset link is invalid, expired, or already used. Request another reset email.' });
      Object.assign(user, hashPassword(password)); delete user.passwordResetTokenHash; delete user.passwordResetExpiresAt;
      for (const [sessionToken, activeSession] of sessions) if (activeSession.userId === user.id) sessions.delete(sessionToken);
      await log('customer_password_reset', { userId: user.id });
      return send(res, 200, { message: 'Password reset successfully. Sign in with your new password.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/account/password') {
      const session = cookieSession(req);
      if (!session?.user) return send(res, 401, { error: 'Sign in to change your password.' });
      const retryAfter = hitRateLimit(req, 'change-password', 5, 60 * 60_000);
      if (retryAfter) return send(res, 429, { error: `Too many password-change attempts. Try again in ${retryAfter} seconds.` }, { 'Retry-After': String(retryAfter) });
      const input = await body(req);
      const currentPassword = String(input.currentPassword || '');
      const newPassword = String(input.newPassword || '');
      const confirmPassword = String(input.confirmPassword || '');
      if (newPassword !== confirmPassword) return send(res, 400, { error: 'Your new password and confirmation do not match.' });
      if (currentPassword.length > 200 || newPassword.length < 12 || newPassword.length > 200) return send(res, 400, { error: 'Enter your current password and a new password between 12 and 200 characters.' });
      const user = session.user;
      const candidate = crypto.scryptSync(currentPassword, Buffer.from(user.salt, 'hex'), 64);
      if (!crypto.timingSafeEqual(candidate, Buffer.from(user.passwordHash, 'hex'))) return send(res, 400, { error: 'Your current password is incorrect. Enter it correctly, then confirm your new password.' });
      if (currentPassword === newPassword) return send(res, 400, { error: 'Choose a new password that is different from your current password.' });
      const salt = crypto.randomBytes(16);
      user.salt = salt.toString('hex');
      user.passwordHash = crypto.scryptSync(newPassword, salt, 64).toString('hex');
      for (const [token, activeSession] of sessions) if (activeSession.userId === user.id) sessions.delete(token);
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.set(token, { userId: user.id, expiresAt: Date.now() + 7 * 86400_000 });
      await log('customer_password_changed_preview', { userId: user.id });
      return send(res, 200, { message: 'Password has been changed successfully.' }, { 'Set-Cookie': sessionCookie(token, req) });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      const session = cookieSession(req); if (session) sessions.delete(session.token);
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', req, 0) });
    }
    if (req.method === 'POST' && url.pathname === '/api/account/verification/documents') {
      const user = cookieSession(req)?.user;
      if (!user) return send(res, 401, { error: 'Sign in to securely submit verification documents.' });
      if (user.verificationStatus === 'under_review' || user.verificationStatus === 'verified') return send(res, 409, { error: 'Documents cannot be changed while a review is pending or after verification.' });
      const retryAfter = hitRateLimit(req, 'verification-document-upload', 12, 60 * 60_000);
      if (retryAfter) return send(res, 429, { error: `Too many document uploads. Try again in ${retryAfter} seconds.` }, { 'Retry-After': String(retryAfter) });
      const hostname = String(req.headers.host || '').split(':')[0].replace(/^\[|\]$/g, '').toLowerCase();
      const isLocal = ['localhost', '127.0.0.1', '::1'].includes(hostname);
      if (!isLocal && req.socket.encrypted !== true && req.headers['x-forwarded-proto'] !== 'https') return send(res, 400, { error: 'Secure document uploads require an HTTPS connection.' });
      const input = await body(req, 14 * 1024 * 1024);
      const side = String(input.side || '');
      const expectedMime = String(input.mimeType || '').toLowerCase();
      const data = String(input.data || '');
      if (!['front', 'back', 'address'].includes(side)) return send(res, 400, { error: 'Choose front ID, back ID, or proof of address.' });
      if (!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data) || data.length > 14 * 1024 * 1024) return send(res, 400, { error: 'The uploaded file is not valid. Choose a JPG, PNG, WEBP, or PDF file.' });
      const file = Buffer.from(data, 'base64');
      if (!file.length || file.length > 10 * 1024 * 1024) return send(res, 413, { error: 'Each verification document must be 10 MB or smaller.' });
      const signatures = [
        { mime: 'image/jpeg', ext: 'jpg', valid: file.length >= 3 && file[0] === 0xff && file[1] === 0xd8 && file[2] === 0xff },
        { mime: 'image/png', ext: 'png', valid: file.length >= 8 && file.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) },
        { mime: 'image/webp', ext: 'webp', valid: file.length >= 12 && file.toString('ascii', 0, 4) === 'RIFF' && file.toString('ascii', 8, 12) === 'WEBP' },
        { mime: 'application/pdf', ext: 'pdf', valid: file.toString('ascii', 0, 5) === '%PDF-' },
      ];
      const detected = signatures.find(signature => signature.mime === expectedMime && signature.valid);
      if (!detected) return send(res, 400, { error: 'The file contents do not match a supported JPG, PNG, WEBP, or PDF format.' });
      const fileId = secureDocuments.put(file);
      const documents = user.verificationDocuments || [];
      const previous = documents.find(document => document.side === side);
      if (previous) secureDocuments.remove(previous.fileId);
      user.verificationDocuments = documents.filter(document => document.side !== side);
      user.verificationDocuments.push({ side, fileId, mimeType: detected.mime, extension: detected.ext, sizeBytes: file.length, uploadedAt: new Date().toISOString() });
      await log('customer_verification_document_uploaded', { userId: user.id, side, sizeBytes: file.length, mimeType: detected.mime });
      return send(res, 201, { ok: true, document: { side, mimeType: detected.mime, sizeBytes: file.length, uploadedAt: user.verificationDocuments.find(document => document.side === side).uploadedAt }, message: 'Document encrypted and saved for admin review.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/account/verification') {
      const user = cookieSession(req)?.user;
      if (!user) return send(res, 401, { error: 'Sign in to submit an identity review request.' });
      const retryAfter = hitRateLimit(req, 'identity-verification', 3, 60 * 60_000);
      if (retryAfter) return send(res, 429, { error: `Please wait ${retryAfter} seconds before trying again.` }, { 'Retry-After': String(retryAfter) });
      if (publicUser(user).identityVerified) return send(res, 409, { error: 'This account is already verified.' });
      if (user.verificationStatus === 'under_review') return send(res, 409, { error: 'Your verification request is already pending admin review.' });
      const input = await body(req);
      const allowedDocuments = ['passport', 'national_id', 'drivers_license'];
      const documentType = String(input.documentType || '');
      const issuingCountry = String(input.issuingCountry || '').trim();
      const requiredSides = ['front', 'back', 'address'];
      if (!allowedDocuments.includes(documentType) || issuingCountry.length < 2 || issuingCountry.length > 80 || !requiredSides.every(side => (user.verificationDocuments || []).some(document => document.side === side))) return send(res, 400, { error: 'Upload the front and back of your ID and proof of address before submitting.' });
      if (String(user.name || '').trim().length < 2 || String(user.address || '').trim().length < 5 || String(user.country || '').trim().length < 2) return send(res, 409, { error: 'Complete your account name, country, and delivery address before verification.' });
      user.verificationStatus = 'under_review';
      user.identityProviderVerified = false;
      user.verificationSubmittedAt = new Date().toISOString();
      user.verificationReviewedAt = null;
      user.verificationDocumentType = documentType;
      user.verificationIssuingCountry = issuingCountry;
      user.manualDocumentReviewAt = null;
      user.verificationMethod = null;
      await log('admin_identity_review_requested_preview', { userId: user.id, submittedAt: user.verificationSubmittedAt, documentType, issuingCountry, documentSides: requiredSides, documentsReceivedByServer: true });
      return send(res, 202, { customer: publicUser(user), message: 'Your request is in the admin review queue.' });
    }
    if (req.method === 'GET' && url.pathname === '/api/account/wallet') {
      const user = cookieSession(req)?.user;
      if (!user) return send(res, 401, { error: 'Sign in to view your funds.' });
      ensureWallet(user);
      const localCurrency = localCurrencyForCountry(user.country); let fx = null; try { fx = await getUsdLocalRate(localCurrency); } catch {}
      const fundingInstructions = {
        bankName: String(process.env.FUNDING_BANK_NAME || ''),
        accountName: String(process.env.FUNDING_BANK_ACCOUNT_NAME || ''),
        accountNumber: String(process.env.FUNDING_BANK_ACCOUNT_NUMBER || ''),
        note: String(process.env.FUNDING_PAYMENT_NOTE || 'Use only verified payment instructions from Gold Investment support. Never transfer to an unverified account.')
      };
      return send(res, 200, { balanceCents: user.walletBalanceCents, transactions: [...user.walletTransactions].sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))), fxRate: fx?.rate || null, fxSource: fx?.source || null, localCurrency, localCurrencyName: currencyName(localCurrency), country: user.country || '', fundingInstructions, minimumMetalPurchaseCents: MINIMUM_PURCHASE_CENTS });
    }
    if (req.method === 'POST' && url.pathname === '/api/account/wallet/deposits') {
      const user = cookieSession(req)?.user;
      if (!user) return send(res, 401, { error: 'Sign in before requesting a deposit.' });
      const input = await body(req);
      const localCurrency = localCurrencyForCountry(user.country);
      const amountLocal = Number(input.amountLocal ?? input.amountNgn);
      const reference = String(input.reference || '').trim();
      if (!Number.isFinite(amountLocal) || amountLocal <= 0 || amountLocal > 1_000_000_000_000) return send(res, 400, { error: `Enter a valid deposit amount in ${localCurrency}.` });
      if (reference.length < 4 || reference.length > 120) return send(res, 400, { error: 'Enter the bank/payment reference from your completed transfer.' });
      if ([...state.users.values()].some(other => (other.walletTransactions || []).some(tx => tx.type === 'deposit' && tx.reference?.toLowerCase() === reference.toLowerCase()))) return send(res, 409, { error: 'That payment reference has already been submitted.' });
      let fx; try { fx = await getUsdLocalRate(localCurrency); } catch (error) { return send(res, 503, { error: error.message || 'The local exchange rate is unavailable.' }); }
      const amountCents = Math.round((amountLocal / fx.rate) * 100);
      if (!Number.isSafeInteger(amountCents) || amountCents < 100) return send(res, 400, { error: `The deposit must be worth at least USD 1.00 (approximately ${new Intl.NumberFormat('en', { style:'currency', currency:localCurrency }).format(fx.rate)}).` });
      ensureWallet(user);
      const tx = { id: `FD-${crypto.randomBytes(5).toString('hex').toUpperCase()}`, type: 'deposit', status: 'pending_admin_review', amountCents, amountLocal, rateLocalPerUsd: fx.rate, localCurrency, ...(localCurrency === 'NGN' ? { amountNgn: amountLocal, rateNgnPerUsd: fx.rate } : {}), reference, createdAt: new Date().toISOString(), currency: 'USD' };
      user.walletTransactions.push(tx);
      await log('wallet_deposit_submitted', { userId: user.id, transactionId: tx.id, amountLocal, localCurrency, amountCents, rateLocalPerUsd: fx.rate, reference });
      return send(res, 202, { transaction: tx, balanceCents: user.walletBalanceCents, message: 'Deposit submitted for admin verification. Your available balance will be credited only after payment is confirmed.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/account/wallet/withdrawals') {
      const user = cookieSession(req)?.user;
      if (!user) return send(res, 401, { error: 'Sign in before requesting a withdrawal.' });
      const input = await body(req); ensureWallet(user);
      const amountCents = Math.round(Number(input.amountUsd) * 100);
      const bankName = String(input.bankName || '').trim(); const accountName = String(input.accountName || '').trim(); const accountNumber = String(input.accountNumber || '').trim();
      if (!Number.isSafeInteger(amountCents) || amountCents < 100 || amountCents > 100_000_000_000) return send(res, 400, { error: 'Enter a withdrawal amount of at least $1.00.' });
      if (amountCents > user.walletBalanceCents) return send(res, 409, { error: 'Your available balance is too low for that withdrawal.' });
      if (bankName.length < 2 || bankName.length > 100 || accountName.length < 2 || accountName.length > 100 || !/^[0-9-]{6,24}$/.test(accountNumber)) return send(res, 400, { error: 'Enter a valid bank name, account name, and account number.' });
      const localCurrency = localCurrencyForCountry(user.country);
      let fx; try { fx = await getUsdLocalRate(localCurrency); } catch (error) { return send(res, 503, { error: error.message || 'The local exchange rate is unavailable.' }); }
      const amountLocal = Math.round((amountCents / 100) * fx.rate * 100) / 100;
      const tx = { id: `WD-${crypto.randomBytes(5).toString('hex').toUpperCase()}`, type: 'withdrawal', status: 'pending_admin_review', amountCents, amountLocal, rateLocalPerUsd: fx.rate, ...(localCurrency === 'NGN' ? { amountNgn: amountLocal, rateNgnPerUsd: fx.rate } : {}), localCurrency, bankName, accountName, accountNumber, createdAt: new Date().toISOString(), currency: 'USD' };
      user.walletBalanceCents -= amountCents;
      user.walletTransactions.push(tx);
      await log('wallet_withdrawal_requested', { userId: user.id, transactionId: tx.id, amountCents, amountLocal, localCurrency, rateLocalPerUsd: fx.rate });
      return send(res, 202, { transaction: tx, balanceCents: user.walletBalanceCents, message: 'Withdrawal request submitted. The amount is reserved until admin review; it will be returned if the request is rejected.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/account/wallet/purchase') {
      const user = cookieSession(req)?.user;
      if (!user) return send(res, 401, { error: 'Sign in before buying with your wallet.' });
      if (!purchaseVerificationApproved(user)) return send(res, 403, { error: 'Your identity review must be approved before buying metals.' });
      const input = await body(req); ensureWallet(user);
      const quoteId = String(input.quoteId || ''); const quote = quotes.get(quoteId);
      if (!quote || quote.type !== 'purchase' || quote.expiresAt <= Date.now()) return send(res, 409, { error: 'The checkout quote has expired. Request a fresh quote before paying.' });
      if (!Array.isArray(input.items) || JSON.stringify(input.items) !== JSON.stringify(quote.lines.map(line => ({ productId: line.productId, quantity: line.quantity })))) return send(res, 409, { error: 'The cart changed. Refresh your quote before using wallet funds.' });
      if (quote.country.toLowerCase() !== String(user.country || '').toLowerCase() || quote.custodyPreference !== String(input.custodyPreference || '')) return send(res, 409, { error: 'The saved country or custody choice does not match this quote.' });
      if (user.walletBalanceCents < quote.totalCents) return send(res, 409, { error: 'Your wallet balance is not enough for this order. Choose another payment method.' });
      for (const line of quote.lines) { const product = products.find(item => item.id === line.productId); if (!product || product.stock < line.quantity) return send(res, 409, { error: `${line.name} is no longer available in the requested quantity.` }); }
      for (const line of quote.lines) products.find(item => item.id === line.productId).stock -= line.quantity;
      user.walletBalanceCents -= quote.totalCents;
      const now = new Date();
      const order = { id: `GI-${crypto.randomBytes(4).toString('hex').toUpperCase()}`, status: 'paid', paymentMethod: 'wallet', paymentStatus: 'paid', fulfillmentStatus: 'processing', custodyPreference: quote.custodyPreference, vaultDurationMonths: quote.vaultDurationMonths || null, createdAt: now.toISOString(), customer: { name: user.name, email: user.email, address: user.address, city: user.city, region: user.region, country: user.country, postalCode: user.postalCode }, lines: quote.lines, subtotalCents: quote.subtotalCents, serviceFeeCents: quote.serviceFeeCents, setupFeeCents: quote.setupFeeCents, storageFeeCents: quote.storageFeeCents, administrationFeeCents: quote.administrationFeeCents, deliveryFeeCents: quote.deliveryFeeCents, storageType: quote.storageType, taxCents: quote.taxCents, taxRatePct: quote.taxRate * 100, totalCents: quote.totalCents, currency: 'USD', walletPayment: { paidAt: now.toISOString(), amountCents: quote.totalCents } };
      if (quote.custodyPreference === 'vault') { const unlockAt = new Date(now); unlockAt.setUTCMonth(unlockAt.getUTCMonth() + quote.vaultDurationMonths); order.vault = { status: 'locked', paymentTag: 'VAULT PAYMENT', amountCents: quote.subtotalCents, durationMonths: quote.vaultDurationMonths, approvedAt: now.toISOString(), unlockAt: unlockAt.toISOString(), lines: quote.lines.map(line => ({ productId: line.productId, name: line.name, metal: line.metal, weightOz: line.weightOz || null, purity: line.purity || 'Not recorded', quantity: line.quantity })) }; }
      state.orders.push(order);
      user.walletTransactions.push({ id: `BUY-${crypto.randomBytes(5).toString('hex').toUpperCase()}`, type: 'purchase', status: 'completed', amountCents: -quote.totalCents, createdAt: now.toISOString(), currency: 'USD', orderId: order.id, note: 'Metal purchase paid from wallet balance.' });
      quotes.delete(quoteId);
      await log('wallet_metal_purchase_paid', { userId: user.id, orderId: order.id, amountCents: quote.totalCents, custodyPreference: quote.custodyPreference });
      return send(res, 201, { order: { id: order.id, status: order.status, paymentStatus: order.paymentStatus, fulfillmentStatus: order.fulfillmentStatus, totalCents: order.totalCents }, balanceCents: user.walletBalanceCents, message: 'Order paid from your wallet balance. Fulfillment is now processing.' });
    }
    if (req.method === 'GET' && url.pathname === '/api/account/dashboard') {
      const user = cookieSession(req)?.user;
      if (!user) return send(res, 401, { error: 'Sign in to view your account dashboard.' });
      return send(res, 200, { customer: publicUser(user), orders: state.orders.filter(o => o.customer.email === user.email), sellOrders: state.sales.filter(o => o.customer.email === user.email) });
    }
    if (req.method === 'POST' && url.pathname === '/api/account/deletion-request') {
      const user = cookieSession(req)?.user;
      if (!user) return send(res, 401, { error: 'Sign in to request account deletion.' });
      const retryAfter = hitRateLimit(req, 'account-deletion-request', 3, 60 * 60_000);
      if (retryAfter) return send(res, 429, { error: `Please wait ${retryAfter} seconds before trying again.` }, { 'Retry-After': String(retryAfter) });
      const input = await body(req);
      if (input.confirmation !== 'REQUEST_DELETION') return send(res, 400, { error: 'Confirm that you understand account deletion removes your records and requires new registration and verification.' });
      if (user.accountDeletionRequestedAt) return send(res, 409, { error: 'Your account deletion request is already pending admin review.' });
      user.accountDeletionRequestedAt = new Date().toISOString();
      await log('customer_account_deletion_requested', { userId: user.id, requestedAt: user.accountDeletionRequestedAt });
      return send(res, 202, { customer: publicUser(user), message: 'Your account deletion request has been sent to the admin. Your account remains active until an admin completes the deletion.' });
    }
    if (req.method === 'PATCH' && url.pathname === '/api/account/profile') {
      const user = cookieSession(req)?.user;
      if (!user) return send(res, 401, { error: 'Sign in to update your account details.' });
      const input = await body(req); const firstName = String(input.firstName || '').trim(); const lastName = String(input.lastName || '').trim(); const email = String(input.email || '').trim().toLowerCase();
      const currentPassword = String(input.currentPassword || '');
      const phone = String(input.phone || '').trim(); const country = String(input.country || '').trim(); const address = String(input.address || '').trim(); const city = String(input.city || '').trim(); const region = String(input.region || '').trim(); const postalCode = String(input.postalCode || '').trim();
      if (!passwordMatches(user, currentPassword)) return send(res, 401, { error: 'Enter your current password to confirm important account changes.' });
      if (firstName.length < 1 || firstName.length > 80 || lastName.length < 1 || lastName.length > 80 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || phone.length > 32 || country.length < 2 || country.length > 80 || address.length < 5 || address.length > 250 || city.length < 2 || city.length > 100 || region.length > 100 || postalCode.length > 24) return send(res, 400, { error: 'Check your name, email, phone, country, address, city, and region fields.' });
      if (email !== user.email && state.users.has(email)) return send(res, 409, { error: 'That email is already connected to another account.' });
      const emailChanged = email !== user.email;
      let pendingEmailVerification = null;
      if (emailChanged) {
        if (!process.env.SECURESMTP_API_KEY) return send(res, 503, { error: 'Email confirmation is unavailable. No profile changes were saved; configure email delivery and try again.' });
        const pending = createOneTimeToken(); pendingEmailVerification = { email, hash: pending.hash, expiresAt: pending.expiresAt };
        try { const { sendVerificationEmail } = require('./services/email'); const result = await sendVerificationEmail({ to: email, firstName, token: pending.token, purpose: 'email-change' }); if (result?.skipped) throw new Error(result.reason); }
        catch (error) { console.error('Email change verification failed:', error.message); return send(res, 502, { error: 'We could not send a verification email to the new address. No profile changes were saved.' }); }
      }
      user.firstName = firstName; user.lastName = lastName; user.name = `${firstName} ${lastName}`; user.phone = phone; user.country = country; user.address = address; user.city = city; user.region = region; user.postalCode = postalCode;
      if (pendingEmailVerification) user.pendingEmailVerification = pendingEmailVerification;
      for (const order of state.orders) if (order.customer.email === user.email) Object.assign(order.customer, { name: user.name, country, address, city, region, postalCode });
      for (const sale of state.sales) if (sale.customer.email === user.email) Object.assign(sale.customer, { name: user.name, country });
      await log('customer_profile_updated', { userId: user.id, emailChangeRequested: emailChanged });
      return send(res, 200, { customer: publicUser(user), message: emailChanged ? 'Your profile was updated. Check the new email address and confirm it before the email address changes.' : 'Your account details were updated.' });
    }
    const paymentStatusMatch = url.pathname.match(/^\/api\/account\/orders\/([^/]+)\/payment-status$/);
    if (req.method === 'GET' && paymentStatusMatch) {
      const user = cookieSession(req)?.user;
      if (!user) return send(res, 401, { error: 'Sign in to check your order payment status.' });
      const order = state.orders.find(item => item.id === decodeURIComponent(paymentStatusMatch[1]) && item.customer.email === user.email);
      if (!order) return send(res, 404, { error: 'Order not found for this account.' });
      return send(res, 200, { orderId: order.id, paymentStatus: order.paymentStatus, paid: order.paymentStatus === 'paid' });
    }
    if (req.method === 'GET' && url.pathname === '/api/prices') { await refreshSpotPrices(); return send(res, 200, { source: priceSource, asOf: priceAsOf, disclaimer: 'Spot reference only. Product premiums, final quotes, fees, tax and availability may differ.', metals: { gold: { perOz: spot.gold, perGram: spot.gold / 31.1034768, currency: 'USD' }, silver: { perOz: spot.silver, perGram: spot.silver / 31.1034768, currency: 'USD' } } }); }
    if (req.method === 'GET' && url.pathname === '/api/products') { await refreshSpotPrices(); return send(res, 200, { products: products.map(pricing), minimumPurchaseCents: MINIMUM_PURCHASE_CENTS, priceSource }); }
    if (req.method === 'POST' && url.pathname === '/api/quote') {
      await refreshSpotPrices(true);
      const input = await body(req);
      const country = String(input.country || '').trim();
      const custodyPreference = String(input.custodyPreference || 'delivery');
      const vaultDurationMonths = custodyPreference === 'vault' ? Number(input.vaultDurationMonths || 1) : null;
      if (country.length < 2 || country.length > 80 || !['vault', 'delivery'].includes(custodyPreference)) return send(res, 400, { error: 'Choose a valid country and custody option to estimate fees.' });
      if (custodyPreference === 'vault' && (!Number.isInteger(vaultDurationMonths) || vaultDurationMonths < 1 || vaultDurationMonths > 12)) return send(res, 400, { error: 'Choose a vault duration from 1 to 12 months.' });
      if (!Array.isArray(input.items) || !input.items.length || input.items.length > 20) return send(res, 400, { error: 'Add between 1 and 20 product lines.' });
      const lines = [];
      for (const item of input.items) {
        const p = products.find(x => x.id === item.productId);
        const qty = Number(item.quantity);
        if (!p || !Number.isInteger(qty) || qty < 1 || qty > 20) return send(res, 400, { error: 'A product or quantity is invalid.' });
        if (qty > p.stock) return send(res, 409, { error: `${p.name} has only ${p.stock} available.` });
        const current = pricing(p);
        lines.push({ productId: p.id, name: p.name, metal: p.metal, weightOz: p.weightOz, purity: p.purity, quantity: qty, unitPriceCents: current.priceCents, lineTotalCents: current.priceCents * qty });
      }
      const subtotalCents = lines.reduce((a, x) => a + x.lineTotalCents, 0);
      if (subtotalCents < MINIMUM_PURCHASE_CENTS) return send(res, 422, { error: 'Minimum initial purchase requirement is $10,000.00 USD per order.', minimumPurchaseCents: MINIMUM_PURCHASE_CENTS, subtotalCents });
      const storageType = custodyPreference === 'vault' ? String(input.storageType || 'allocated') : null;
      if (custodyPreference === 'vault' && !['allocated', 'unallocated'].includes(storageType)) return send(res, 400, { error: 'Choose allocated or unallocated vault storage.' });
      const configuredTaxRate = Number(process.env.CHECKOUT_ESTIMATED_TAX_RATE ?? 0.08);
      const taxRate = Number.isFinite(configuredTaxRate) && configuredTaxRate >= 0 && configuredTaxRate <= 1 ? configuredTaxRate : 0.08;
      const configuredDeliveryCents = Number(process.env.CHECKOUT_DELIVERY_FEE_CENTS ?? 2500);
      const deliveryFeeCents = custodyPreference === 'delivery' ? configuredDeliveryCents : 0;
      const setupFeeCents = 5000;
      const storageFeeCents = custodyPreference === 'vault' ? (storageType === 'allocated' ? 10000 : 1500) : 0;
      const administrationFeeCents = custodyPreference === 'vault' ? 12500 : 0;
      const serviceFeeCents = setupFeeCents + deliveryFeeCents + storageFeeCents + administrationFeeCents;
      if (![deliveryFeeCents, setupFeeCents, storageFeeCents, administrationFeeCents].every(value => Number.isInteger(value) && value >= 0 && value <= 100_000_000)) return send(res, 500, { error: 'Checkout fee configuration is invalid.' });
      const taxableAmountCents = subtotalCents + serviceFeeCents;
      const taxCents = Math.round(taxableAmountCents * taxRate);
      const totalCents = taxableAmountCents + taxCents;
      const quoteId = crypto.randomUUID();
      quotes.set(quoteId, { type: 'purchase', expiresAt: Date.now() + CRYPTO_WINDOW_MS, lines, subtotalCents, country, custodyPreference, vaultDurationMonths, storageType, setupFeeCents, storageFeeCents, administrationFeeCents, deliveryFeeCents, serviceFeeCents, taxCents, taxRate, totalCents });
      return send(res, 200, { quoteId, currency: 'USD', expiresInSeconds: CRYPTO_WINDOW_MS / 1000, source: priceSource, lines, country, custodyPreference, vaultDurationMonths, storageType, subtotalCents, setupFeeCents, storageFeeCents, administrationFeeCents, deliveryFeeCents, serviceFeeCents, serviceFeeLabel: custodyPreference === 'vault' ? 'Vault and account fees' : 'Account set-up and delivery fees', taxCents, taxRatePct: taxRate * 100, taxableAmountCents, totalCents, note: 'Tax is a configurable general estimate applied to the subtotal and listed fees; it is not a jurisdiction-specific tax determination. Confirm actual taxes and fees before production checkout.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/crypto/payments') {
      if (process.env.CRYPTO_PAYMENTS_ENABLED !== 'true') return send(res, 503, { error: 'Crypto checkout is off. Set CRYPTO_PAYMENTS_ENABLED=true in the server .env file and restart the server. Chain API keys are optional when an admin will manually review transactions.' });
      const session = cookieSession(req); const user = session?.user;
      if (!user) return send(res, 401, { error: 'Sign in before starting a crypto payment.' });
      if (!purchaseVerificationApproved(user)) return send(res, 403, { error: 'Your identity review must be approved by an administrator before you can purchase.' });
      const input = await body(req);
      const asset = String(input.asset || '').toUpperCase(); const network = String(input.network || '').toUpperCase();
      const isBitcoin = asset === 'BTC' && network === 'BITCOIN';
      const token = selectedToken(asset, network);
      if (!isBitcoin && !token) return send(res, 400, { error: 'That coin and network combination is not supported. USDC is enabled only on Ethereum; USDT is enabled on Ethereum, BNB Smart Chain, and TRON.' });
      const receiveAddress = isBitcoin ? String(process.env.CRYPTO_BTC_RECEIVE_ADDRESS || '15RsgmaFM74gDTpXtx1GvtJvCgGWsp2f76').trim() : network === 'TRON' ? String(process.env.CRYPTO_TRON_RECEIVE_ADDRESS || TRON_RECEIVE_ADDRESS).trim() : String(process.env.CRYPTO_EVM_RECEIVE_ADDRESS || EVM_RECEIVE_ADDRESS).trim();
      if (isBitcoin && !validBitcoinAddress(receiveAddress)) return send(res, 503, { error: 'Bitcoin payments need a valid server-configured receiving address.' });
      if (token?.chain === 'TRON' && !decodeTronAddress(receiveAddress)) return send(res, 503, { error: 'The configured TRON receiving address is invalid.' });
      if (token?.chain !== 'TRON' && token && !/^0x[a-f0-9]{40}$/i.test(receiveAddress)) return send(res, 503, { error: 'The configured EVM receiving address is invalid.' });
      const quoteId = String(input.quoteId || '');
      const existingOrder = state.orders.find(order => order.cryptoPayment?.quoteId === quoteId && order.customer?.email === user.email && !['cancelled', 'expired', 'payment_rejected'].includes(order.paymentStatus));
      if (existingOrder) return send(res, 200, { orderId: existingOrder.id, payment: { asset: existingOrder.cryptoPayment.asset, network: existingOrder.cryptoPayment.network, address: existingOrder.cryptoPayment.address, amount: existingOrder.cryptoPayment.amountToken || existingOrder.cryptoPayment.amountBTC, currency: existingOrder.cryptoPayment.asset, rateUsd: existingOrder.cryptoPayment.rateUsd || null, expiresAt: existingOrder.cryptoPayment.expiresAt, status: existingOrder.cryptoPayment.status }, message: 'Your existing crypto payment request is ready.' });
      const quote = quotes.get(quoteId);
      if (!quote || quote.type !== 'purchase' || quote.expiresAt <= Date.now()) return send(res, 409, { error: 'The checkout quote has expired. Refresh and accept a current price before starting payment.' });
      if (!Array.isArray(input.items) || JSON.stringify(input.items) !== JSON.stringify(quote.lines.map(line => ({ productId: line.productId, quantity: line.quantity })))) return send(res, 409, { error: 'The cart changed. Review it and request a fresh checkout quote.' });
      if (quote.country.toLowerCase() !== String(user.country || '').toLowerCase() || quote.custodyPreference !== String(input.custodyPreference || '')) return send(res, 409, { error: 'The saved country or custody choice does not match this quote. Return to checkout and refresh the quote.' });
      if (quote.subtotalCents < MINIMUM_PURCHASE_CENTS) return send(res, 422, { error: 'Minimum initial purchase requirement is $10,000.00 USD per order.' });
      for (const line of quote.lines) { const product = products.find(item => item.id === line.productId); if (!product || product.stock < line.quantity) return send(res, 409, { error: `${line.name} is no longer available in the requested quantity.` }); }
      let rateUsd = null; let amountSatoshis = null; let amountUnits = null;
      if (isBitcoin) {
        let addressCheck;
        try { [rateUsd, addressCheck] = await Promise.all([getBitcoinUsdSellRate(), blockchainRequest('/btc/address', { address: receiveAddress })]); } catch { return send(res, 502, { error: 'Blockchain.com could not validate the configured Bitcoin address and rate. No payment request was created.' }); }
        if (String(addressCheck.address || '').toLowerCase() !== receiveAddress.toLowerCase()) return send(res, 503, { error: 'Blockchain.com did not validate the configured Bitcoin receiving address. No payment request was created.' });
        amountSatoshis = Math.ceil((quote.totalCents / 100 / rateUsd) * 100_000_000);
        if (!Number.isSafeInteger(amountSatoshis) || amountSatoshis < 1) return send(res, 500, { error: 'Could not calculate the Bitcoin invoice amount safely.' });
      } else amountUnits = amountUnitsFromCents(quote.totalCents, token.decimals);
      const amountToken = isBitcoin ? (amountSatoshis / 100_000_000).toFixed(8) : formatTokenUnits(amountUnits, token.decimals);
      for (const line of quote.lines) products.find(item => item.id === line.productId).stock -= line.quantity;
      const now = Date.now(); const payment = { quoteId, asset, network, address: receiveAddress, tokenContract: token?.contract || null, decimals: token?.decimals || null, chainId: token?.chainId || null, amountUnits, amountToken, rateUsd, amountSatoshis, amountBTC: isBitcoin ? amountToken : null, expiresAt: new Date(now + CRYPTO_WINDOW_MS).toISOString(), status: 'awaiting_payment', inventoryReserved: true, txId: null };
      const order = { id: `GI-${crypto.randomBytes(4).toString('hex').toUpperCase()}`, status: 'awaiting_crypto_payment', paymentMethod: 'crypto', paymentStatus: 'awaiting_crypto', fulfillmentStatus: 'unfulfilled', custodyPreference: quote.custodyPreference, vaultDurationMonths: quote.vaultDurationMonths || null, createdAt: new Date(now).toISOString(), customer: { name: user.name, email: user.email, address: user.address, city: user.city, region: user.region, country: user.country, postalCode: user.postalCode }, lines: quote.lines, subtotalCents: quote.subtotalCents, serviceFeeCents: quote.serviceFeeCents, setupFeeCents: quote.setupFeeCents, storageFeeCents: quote.storageFeeCents, administrationFeeCents: quote.administrationFeeCents, deliveryFeeCents: quote.deliveryFeeCents, storageType: quote.storageType, taxCents: quote.taxCents, taxRatePct: quote.taxRate * 100, totalCents: quote.totalCents, currency: 'USD', cryptoPayment: payment };
      state.orders.push(order);
      await log('crypto_payment_intent_created', { orderId: order.id, asset, network, expiresAt: payment.expiresAt, totalCents: order.totalCents });
      return send(res, 201, { orderId: order.id, payment: { asset, network, address: receiveAddress, amount: amountToken, currency: asset, rateUsd, expiresAt: payment.expiresAt, status: payment.status }, message: `${asset} payment request created. Send the exact amount on ${token?.networkName || 'Bitcoin'} before the timer expires, then submit the transaction ID for server verification.` });
    }
    const cryptoVerifyMatch = url.pathname.match(/^\/api\/crypto\/payments\/([^/]+)\/verify$/);
    if (req.method === 'POST' && cryptoVerifyMatch) {
      if (process.env.CRYPTO_PAYMENTS_ENABLED !== 'true') return send(res, 503, { error: 'Cryptocurrency payments are disabled on this server.' });
      const user = cookieSession(req)?.user;
      if (!user) return send(res, 401, { error: 'Sign in to submit a transaction ID.' });
      const order = state.orders.find(item => item.id === decodeURIComponent(cryptoVerifyMatch[1]) && item.customer?.email === user.email);
      if (!order?.cryptoPayment || order.paymentMethod !== 'crypto') return send(res, 404, { error: 'Crypto payment request not found.' });
      if (order.paymentStatus === 'paid') return send(res, 200, { paid: true, status: 'confirmed', confirmations: order.cryptoPayment.confirmations, message: 'Payment is already confirmed.' });
      if (order.paymentStatus === 'pending_admin_review') return send(res, 202, { paid: false, status: 'pending_admin_review', message: 'Your on-chain payment was verified and sent to the admin for approval. Your account will be credited after approval.' });
      if (order.paymentStatus === 'expired') return send(res, 410, { error: 'This payment request expired. Do not send funds to its address; contact customer care if you already paid.' });
      if (order.paymentStatus === 'cancelled' || order.paymentStatus === 'payment_rejected') return send(res, 410, { error: 'This payment request is closed. Contact customer care if you already transferred funds.' });
      const input = await body(req); const txId = String(input.txId || '').trim().toLowerCase().replace(/^0x/, '');
      if (!/^[a-f0-9]{64}$/.test(txId)) return send(res, 400, { error: 'Enter a valid 64-character transaction ID or hash for the selected network.' });
      if (order.cryptoPayment.txId && order.cryptoPayment.txId !== txId) return send(res, 409, { error: 'A transaction ID is already attached to this order. Contact customer care if it is incorrect.' });
      if (state.orders.some(item => item.id !== order.id && item.cryptoPayment?.txId === txId)) return send(res, 409, { error: 'That transaction ID has already been submitted for another order.' });
      const payment = order.cryptoPayment; const lockKey = `${payment.network}:${txId}`;
      if (cryptoVerificationLocks.has(lockKey)) return send(res, 409, { error: 'This transaction is being checked. Wait a moment and try again.' });
      cryptoVerificationLocks.add(lockKey);
      let result;
      try {
        if (payment.asset === 'BTC' && payment.network === 'BITCOIN') {
          let transaction, tip;
          [transaction, tip] = await Promise.all([blockchainRequest('/btc/transaction', { txId }), blockchainRequest('/btc/blocks', { limit: 1 })]);
          if (String(transaction.txId || '').toLowerCase() !== txId || transaction.deleted === true) result = { found: false, error: 'Blockchain.com did not return a valid Bitcoin transaction for this ID.' };
          else {
            const outputs = Array.isArray(transaction.outputs) ? transaction.outputs : [];
            const receivedSatoshis = outputs.filter(output => String(output.address || '').toLowerCase() === payment.address.toLowerCase()).reduce((sum, output) => { const value = Number(output.value); return Number.isSafeInteger(value) && value > 0 ? sum + value : sum; }, 0);
            const txTime = Number(transaction.timestamp || transaction.mempoolTime || 0) * 1000;
            const intentStart = new Date(order.createdAt).getTime(); const intentExpiry = new Date(payment.expiresAt).getTime();
            if (receivedSatoshis < payment.amountSatoshis) result = { found: false, error: 'This transaction does not send the required Bitcoin amount to the configured receiving address.' };
            else if (!txTime || txTime < intentStart - 60_000 || txTime > intentExpiry) result = { found: false, error: 'The transaction was not broadcast during this payment window.' };
            else { const blockHeight = Number(transaction.blockHeight || 0); const currentHeight = Number(tip.currentHeight || 0); const confirmations = transaction.mempool === true || blockHeight <= 0 || currentHeight < blockHeight ? 0 : currentHeight - blockHeight + 1; result = { found: true, confirmations, receivedUnits: String(receivedSatoshis), requiredConfirmations: BTC_CONFIRMATIONS_REQUIRED }; }
          }
        } else if (payment.network === 'TRON') result = await verifyTronUsdt(order, txId);
        else result = await verifyEvmStablecoin(order, `0x${txId}`);
      } catch (error) {
        cryptoVerificationLocks.delete(lockKey);
        payment.txId = txId; payment.transactionSubmittedAt ||= new Date().toISOString(); payment.manualReviewRequestedAt = new Date().toISOString(); payment.confirmationDeadlineAt = null; payment.status = 'pending_admin_review';
        order.paymentStatus = 'pending_admin_review'; order.status = 'pending_admin_review';
        await log('crypto_payment_manual_review_requested', { orderId: order.id, txId, network: payment.network, asset: payment.asset, reason: 'on_chain_verifier_unavailable' });
        return send(res, 202, { paid: false, status: 'pending_admin_review', orderId: order.id, message: 'Your transaction ID was submitted for manual admin review because the automatic network checker is unavailable. The order will not be credited until an admin verifies the blockchain record and approves it.' });
      }
      cryptoVerificationLocks.delete(lockKey);
      if (!result?.found) return send(res, 422, { error: result?.error || 'The selected chain did not verify the payment.' });
      payment.txId = txId; payment.transactionSubmittedAt ||= new Date().toISOString(); payment.confirmationDeadlineAt ||= new Date(Date.now() + 24 * 60 * 60_000).toISOString(); payment.confirmations = result.confirmations;
      const requiredConfirmations = result.requiredConfirmations || (payment.network === 'TRON' ? 1 : EVM_CONFIRMATIONS_REQUIRED);
      if (result.confirmations < requiredConfirmations) {
        payment.status = 'pending_confirmations';
        order.paymentStatus = 'pending_confirmations'; order.status = 'pending_confirmations';
        await log('crypto_transaction_seen_pending', { orderId: order.id, txId, network: payment.network, confirmations: result.confirmations });
        return send(res, 202, { paid: false, status: 'pending_confirmations', confirmations: result.confirmations, requiredConfirmations, message: `Transaction found and amount matched. Waiting for ${requiredConfirmations} ${payment.network} confirmations before it can be sent to admin review.` });
      }
      order.paymentStatus = 'pending_admin_review'; order.status = 'pending_admin_review'; payment.status = 'pending_admin_review'; payment.chainVerifiedAt = new Date().toISOString(); payment.receivedUnits = result.receivedUnits; payment.confirmationDeadlineAt = null;
      await log('crypto_payment_awaiting_admin_review', { orderId: order.id, txId, network: payment.network, asset: payment.asset, confirmations: result.confirmations, receivedUnits: result.receivedUnits });
      return send(res, 202, { paid: false, status: 'pending_admin_review', confirmations: result.confirmations, orderId: order.id, message: 'Your transaction passed the on-chain checks and is pending admin approval. Your account will be credited after the admin approves it.' });
    }
    const cryptoCancelMatch = url.pathname.match(/^\/api\/crypto\/payments\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && cryptoCancelMatch) {
      const user = cookieSession(req)?.user;
      if (!user) return send(res, 401, { error: 'Sign in to cancel this payment request.' });
      const order = state.orders.find(item => item.id === decodeURIComponent(cryptoCancelMatch[1]) && item.customer?.email === user.email);
      if (!order?.cryptoPayment || order.paymentMethod !== 'crypto') return send(res, 404, { error: 'Crypto payment request not found.' });
      const payment = order.cryptoPayment;
      if (order.paymentStatus === 'expired') return send(res, 410, { error: 'This timed payment request has already expired.' });
      if (payment.txId || payment.chainVerifiedAt || order.paymentStatus === 'pending_admin_review' || order.paymentStatus === 'paid') return send(res, 409, { error: 'This request has a submitted transaction. It cannot be cancelled; wait for admin review or contact customer care.' });
      if (payment.inventoryReserved) { for (const line of order.lines || []) { const product = products.find(item => item.id === line.productId); if (product) product.stock += line.quantity; } payment.inventoryReserved = false; }
      order.status = 'cancelled'; order.paymentStatus = 'cancelled'; payment.status = 'cancelled';
      await log('crypto_payment_cancelled', { orderId: order.id, customerEmail: user.email });
      return send(res, 200, { cancelled: true, message: 'Payment request cancelled. No payment was recorded.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/orders') {
      const buyerSession = cookieSession(req);
      if (!buyerSession?.user) return send(res, 401, { error: 'Sign in before purchasing.' });
      if (!purchaseVerificationApproved(buyerSession.user)) return send(res, 403, { error: 'Your identity review must be approved by an administrator before you can purchase.' });
      await refreshSpotPrices(true);
      const input = await body(req);
      if (!input.quoteId || !Array.isArray(input.items)) return send(res, 400, { error: 'A fresh quote and item list are required.' });
      const quote = quotes.get(input.quoteId);
      if (!quote || quote.type !== 'purchase' || quote.expiresAt < Date.now()) return send(res, 409, { error: 'Quote expired or is invalid. Request a new quote.' });
      const custodyPreference = String(input.custodyPreference || 'delivery');
      const { name, email, address, city, country, region, postalCode } = buyerSession.user;
      if (!['vault', 'delivery'].includes(custodyPreference) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || name.length < 2 || (custodyPreference === 'delivery' && (address.length < 5 || city.length < 2 || country.length < 2)) || country.length > 80 || region.length > 100 || postalCode.length > 24) return send(res, 400, { error: 'Choose vault or delivery and enter valid customer and destination details.' });
      if (country.length < 2 || quote.country.toLowerCase() !== country.toLowerCase() || quote.custodyPreference !== custodyPreference) return send(res, 409, { error: 'Country or custody choice changed. Request a fresh quote.' });
      const quoteItems = input.items;
      const lines = [];
      for (const item of quoteItems) {
        const p = products.find(x => x.id === item.productId); const qty = Number(item.quantity);
        if (!p || !Number.isInteger(qty) || qty < 1 || qty > 20 || qty > p.stock) return send(res, 409, { error: 'Cart changed. Please review your cart and request a new quote.' });
        const current = pricing(p); lines.push({ productId: p.id, name: p.name, metal: p.metal, weightOz: p.weightOz, purity: p.purity, quantity: qty, unitPriceCents: current.priceCents, lineTotalCents: current.priceCents * qty });
      }
      const subtotalCents = lines.reduce((a, x) => a + x.lineTotalCents, 0);
      if (subtotalCents < MINIMUM_PURCHASE_CENTS) return send(res, 422, { error: 'Minimum initial purchase requirement is $10,000.00 USD per order.' });
      if (JSON.stringify(lines) !== JSON.stringify(quote.lines) || subtotalCents !== quote.subtotalCents) return send(res, 409, { error: 'The bullion price or cart changed during checkout. Request and accept a fresh quote before placing this order.', priceChanged: true, currentLines: lines, currentSubtotalCents: subtotalCents });
      const totalCents = quote.totalCents;
      quotes.delete(input.quoteId);
      const order = { id: `GI-${crypto.randomBytes(4).toString('hex').toUpperCase()}`, status: 'awaiting_payment_setup', paymentStatus: 'not_collected_preview', fulfillmentStatus: 'unfulfilled', custodyPreference, vaultDurationMonths: quote.vaultDurationMonths || null, createdAt: new Date().toISOString(), customer: { name, email, address, city, region, country, postalCode }, lines, subtotalCents, serviceFeeCents: quote.serviceFeeCents, setupFeeCents: quote.setupFeeCents, storageFeeCents: quote.storageFeeCents, administrationFeeCents: quote.administrationFeeCents, deliveryFeeCents: quote.deliveryFeeCents, storageType: quote.storageType, taxCents: quote.taxCents, taxRatePct: quote.taxRate * 100, totalCents, currency: 'USD' };
      state.orders.push(order); await log('order_created_preview', { id: order.id, totalCents });
      return send(res, 201, { order: { id: order.id, status: order.status, paymentStatus: order.paymentStatus, fulfillmentStatus: order.fulfillmentStatus, custodyPreference, total: money(totalCents), currency: 'USD' }, message: custodyPreference === 'vault' ? 'Preview vault preference recorded. No bullion was allocated or stored and no payment was collected.' : 'Preview delivery preference recorded. No payment was collected and no shipment was created.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/sell/quote') {
      await refreshSpotPrices();
      const input = await body(req); const metal = String(input.metal || '').toLowerCase(); const weightOz = Number(input.weightOz);
      if (!['gold', 'silver'].includes(metal) || !Number.isFinite(weightOz) || weightOz <= 0 || weightOz > 10_000) return send(res, 400, { error: 'Choose gold or silver and enter a valid weight in troy ounces.' });
      const spotValueCents = Math.round(spot[metal] * weightOz * 100); const buybackCents = Math.round(spotValueCents * 0.95);
      if (buybackCents < MINIMUM_SELL_CENTS) return send(res, 422, { error: `Minimum sell request is $10,000.00 USD in ${metal} after the illustrative buyback adjustment.`, minimumCents: MINIMUM_SELL_CENTS, estimatedValueCents: buybackCents });
      const quoteId = crypto.randomUUID(); const sellQuote = { type: 'sell', metal, weightOz, spotValueCents, buybackCents, expiresAt: Date.now() + 120_000 };
      quotes.set(quoteId, sellQuote);
      return send(res, 200, { quoteId, metal, weightOz, currency: 'USD', source: priceSource, discountPct: 5, spotValueCents, estimatedPayoutCents: buybackCents, expiresInSeconds: 120, note: 'Illustrative buyback estimate only. Metal inspection, shipping and a production dealer offer are not included.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/sell/orders') {
      if (process.env.SELL_WORKFLOW_ENABLED !== 'true') return send(res, 503, { error: 'Sell requests are disabled until identity verification, inspection, and regulated payout workflows are configured.' });
      if (process.env.IDENTITY_PROVIDER_ENABLED !== 'true') return send(res, 503, { error: 'Sell requests require a configured identity-verification provider.' });
      const session = cookieSession(req); if (!session?.user) return send(res, 401, { error: 'Sign in before submitting a sell request.' });
      if (session.user.identityProviderVerified !== true || session.user.verificationStatus !== 'verified') return send(res, 403, { error: 'Complete approved identity and liveness verification before submitting a sell request.' });
      const input = await body(req); const quote = quotes.get(String(input.quoteId || ''));
      if (!quote || quote.type !== 'sell' || quote.expiresAt < Date.now()) return send(res, 409, { error: 'Sell quote expired or invalid. Request a new quote.' });
      quotes.delete(input.quoteId);
      const order = { id: `GS-${crypto.randomBytes(4).toString('hex').toUpperCase()}`, status: 'awaiting_manual_review_preview', createdAt: new Date().toISOString(), metal: quote.metal, weightOz: quote.weightOz, estimatedPayoutCents: quote.buybackCents, currency: 'USD', customer: { email: session.user.email, name: session.user.name, country: session.user.country } };
      state.sales.push(order); await log('sell_request_preview', { id: order.id, metal: order.metal, estimatedPayoutCents: order.estimatedPayoutCents });
      return send(res, 201, { sellOrder: { id: order.id, status: order.status, estimatedPayout: money(order.estimatedPayoutCents), currency: 'USD' }, message: 'Preview sell request recorded for manual review. No metal was shipped and no payout was made.' });
    }
    const adminDocumentsMatch = url.pathname.match(/^\/api\/admin\/customers\/([^/]+)\/documents(?:\/([^/]+))?$/);
    if (req.method === 'GET' && adminDocumentsMatch) {
      if (!adminAuthorized(req)) return send(res, 401, { error: 'Admin authorization required. Sign in to the staff portal again.' });
      const user = state.usersById.get(decodeURIComponent(adminDocumentsMatch[1]));
      if (!user) return send(res, 404, { error: 'Customer not found.' });
      const documents = user.verificationDocuments || [];
      const side = adminDocumentsMatch[2];
      const token = adminTokenFromRequest(req);
      if (!side) return send(res, 200, { documents: documents.map(({ side: documentSide, mimeType, sizeBytes, uploadedAt }) => ({ side: documentSide, mimeType, sizeBytes, uploadedAt })), reviewedSides: [...(adminDocumentViews.get(token)?.get(user.id) || [])] });
      const document = documents.find(item => item.side === side);
      if (!document) return send(res, 404, { error: 'That verification document is unavailable.' });
      let content;
      try { content = secureDocuments.get(document.fileId); } catch { return send(res, 500, { error: 'The encrypted document could not be opened. Preserve the document and encryption key, then contact the system administrator.' }); }
      let viewedCustomers = adminDocumentViews.get(token);
      if (!viewedCustomers) { viewedCustomers = new Map(); adminDocumentViews.set(token, viewedCustomers); }
      if (!viewedCustomers.has(user.id)) viewedCustomers.set(user.id, new Set());
      viewedCustomers.get(user.id).add(side);
      await log('admin_identity_document_viewed', { customerId: user.id, side });
      const filename = `${side}.${document.extension}`;
      res.writeHead(200, { 'Content-Type': document.mimeType, 'Content-Length': content.length, 'Content-Disposition': `inline; filename="${filename}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
      return res.end(content);
    }
    const documentReviewMatch = url.pathname.match(/^\/api\/admin\/customers\/([^/]+)\/documents\/reviewed$/);
    if (req.method === 'POST' && documentReviewMatch) {
      if (!adminAuthorized(req)) return send(res, 401, { error: 'Admin authorization required. Sign in to the staff portal again.' });
      const user = state.usersById.get(decodeURIComponent(documentReviewMatch[1]));
      if (!user) return send(res, 404, { error: 'Customer not found.' });
      const input = await body(req);
      const requiredSides = ['front', 'back', 'address'];
      const viewed = adminDocumentViews.get(adminTokenFromRequest(req))?.get(user.id) || new Set();
      if (user.verificationStatus !== 'under_review' || input.confirmation !== 'REVIEWED' || !requiredSides.every(side => (user.verificationDocuments || []).some(document => document.side === side) && viewed.has(side))) return send(res, 409, { error: 'Open all three submitted documents, then confirm your manual review.' });
      user.manualDocumentReviewAt = new Date().toISOString();
      user.manualDocumentReviewer = adminSessions.get(adminTokenFromRequest(req))?.email || 'admin';
      await log('admin_identity_documents_reviewed', { customerId: user.id, documentSides: requiredSides, reviewedAt: user.manualDocumentReviewAt });
      return send(res, 200, { ok: true, message: 'Document review recorded. You may now approve or reject this verification request.' });
    }
    const cryptoDecisionMatch = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/payment-decision$/);
    if (req.method === 'POST' && cryptoDecisionMatch) {
      if (!adminAuthorized(req)) return send(res, 401, { error: 'Admin authorization required. Sign in to the staff portal again.' });
      const input = await body(req); const decision = String(input.decision || '');
      if (!['approve', 'reject'].includes(decision)) return send(res, 400, { error: 'Choose approve or reject for this transaction.' });
      const order = state.orders.find(item => item.id === decodeURIComponent(cryptoDecisionMatch[1]));
      if (!order?.cryptoPayment || order.paymentMethod !== 'crypto') return send(res, 404, { error: 'Crypto payment order not found.' });
      const payment = order.cryptoPayment;
      if (order.paymentStatus !== 'pending_admin_review' || (!payment.chainVerifiedAt && !payment.manualReviewRequestedAt) || !payment.txId) return send(res, 409, { error: 'This transaction has not passed automatic checks or entered manual admin review.' });
      if (decision === 'approve' && !payment.chainVerifiedAt && input.manualConfirmation !== 'I VERIFIED THE BLOCKCHAIN TRANSFER') return send(res, 400, { error: 'Open the chain explorer, verify the exact token, recipient, amount, payment time, and confirmations, then type the required confirmation.' });
      const reviewer = adminSessions.get(adminTokenFromRequest(req))?.email || 'admin';
      if (decision === 'approve') {
        order.paymentStatus = 'paid'; order.status = 'paid'; payment.status = 'approved_by_admin'; payment.adminApprovedAt = new Date().toISOString(); payment.adminReviewer = reviewer;
        if (order.custodyPreference === 'vault') {
          const months = Number.isInteger(order.vaultDurationMonths) && order.vaultDurationMonths >= 1 && order.vaultDurationMonths <= 12 ? order.vaultDurationMonths : 1;
          const approvedAt = new Date(payment.adminApprovedAt);
          const unlockAt = new Date(approvedAt);
          const day = unlockAt.getDate();
          unlockAt.setDate(1); unlockAt.setMonth(unlockAt.getMonth() + months);
          const lastDay = new Date(unlockAt.getFullYear(), unlockAt.getMonth() + 1, 0).getDate();
          unlockAt.setDate(Math.min(day, lastDay));
          order.vaultDurationMonths = months;
          order.vault = { status: 'locked', paymentTag: 'VAULT PAYMENT', amountCents: order.subtotalCents || order.totalCents, durationMonths: months, approvedAt: approvedAt.toISOString(), unlockAt: unlockAt.toISOString(), lines: (order.lines || []).map(line => ({ productId: line.productId, name: line.name, metal: line.metal, weightOz: line.weightOz || null, purity: line.purity || 'Not recorded', quantity: line.quantity })) };
        }
        if (payment.quoteId) quotes.delete(payment.quoteId);
        await log('crypto_payment_admin_approved', { orderId: order.id, txId: payment.txId, reviewer, customerEmail: order.customer?.email, paymentTag: order.custodyPreference === 'vault' ? 'VAULT PAYMENT' : 'BULLION PAYMENT', vaultUnlockAt: order.vault?.unlockAt || null });
        return send(res, 200, { order, message: order.custodyPreference === 'vault' ? `Payment approved and credited. Vault holding locked for ${order.vaultDurationMonths} month(s), unlocking ${order.vault.unlockAt}.` : 'On-chain transaction approved. The order is now paid and recorded on the customer account.' });
      }
      if (payment.inventoryReserved) { for (const line of order.lines || []) { const product = products.find(item => item.id === line.productId); if (product) product.stock += line.quantity; } payment.inventoryReserved = false; }
      order.paymentStatus = 'payment_rejected'; order.status = 'payment_rejected'; payment.status = 'rejected_by_admin'; payment.adminRejectedAt = new Date().toISOString(); payment.adminReviewer = reviewer;
      await log('crypto_payment_admin_rejected', { orderId: order.id, txId: payment.txId, reviewer, customerEmail: order.customer?.email });
      return send(res, 200, { order, message: 'Transaction rejected. It was not credited to the customer; contact the customer if funds were transferred.' });
    }
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/admin/')) {
      if (!adminAuthorized(req)) return send(res, 401, { error: 'Admin authorization required. Sign in to the staff portal again.' });
      const input = await body(req);
      const productMatch = url.pathname.match(/^\/api\/admin\/products\/([^/]+)$/);
      const orderMatch = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
      const customerMatch = url.pathname.match(/^\/api\/admin\/customers\/([^/]+)$/);
      if (productMatch) {
        const product = products.find(p => p.id === decodeURIComponent(productMatch[1]));
        if (!product) return send(res, 404, { error: 'Product not found.' });
        if (input.stock !== undefined) { const stock = Number(input.stock); if (!Number.isInteger(stock) || stock < 0 || stock > 1_000_000) return send(res, 400, { error: 'Stock must be a whole number between 0 and 1,000,000.' }); product.stock = stock; }
        if (input.premiumPct !== undefined) { const premiumPct = Number(input.premiumPct); if (!Number.isFinite(premiumPct) || premiumPct < 0 || premiumPct > 1) return send(res, 400, { error: 'Premium must be between 0% and 100%.' }); product.premiumPct = premiumPct; }
        if (input.name !== undefined) { const name = String(input.name).trim(); if (name.length < 2 || name.length > 120) return send(res, 400, { error: 'Product name must be between 2 and 120 characters.' }); product.name = name; }
        await log('admin_product_updated_preview', { productId: product.id, stock: product.stock, premiumPct: product.premiumPct });
        return send(res, 200, { product: pricing(product), message: 'Preview product updated in memory. Changes reset when the server stops.' });
      }
      if (orderMatch) {
        const order = state.orders.find(o => o.id === decodeURIComponent(orderMatch[1]));
        if (!order) return send(res, 404, { error: 'Order not found.' });
        const allowed = ['failed', 'unfulfilled', 'processing', 'shipped', 'delivered'];
        if (!allowed.includes(input.fulfillmentStatus)) return send(res, 400, { error: 'Choose a valid fulfillment status.' });
        if (['shipped', 'delivered'].includes(input.fulfillmentStatus) && order.paymentStatus !== 'paid') return send(res, 409, { error: 'Shipping is blocked until a verified payment integration records settlement.' });
        order.fulfillmentStatus = input.fulfillmentStatus;
        await log('admin_fulfillment_updated_preview', { orderId: order.id, fulfillmentStatus: order.fulfillmentStatus });
        return send(res, 200, { order, message: 'Preview fulfillment status updated.' });
      }
      if (customerMatch) {
        const user = state.usersById.get(decodeURIComponent(customerMatch[1]));
        if (!user) return send(res, 404, { error: 'Customer not found.' });
        if (!['not_started', 'under_review', 'verified', 'rejected'].includes(input.verificationStatus)) return send(res, 400, { error: 'Choose a valid verification status.' });
        if (input.verificationStatus === 'verified' && (user.verificationStatus !== 'under_review' || !user.verificationSubmittedAt || !user.manualDocumentReviewAt)) return send(res, 409, { error: 'Open and manually review all submitted documents before approving this account.' });
        user.verificationStatus = input.verificationStatus;
        user.identityProviderVerified = false;
        user.verificationMethod = input.verificationStatus === 'verified' ? 'manual_admin_review' : null;
        user.verificationReviewedAt = ['verified', 'rejected'].includes(input.verificationStatus) ? new Date().toISOString() : null;
        await log('admin_customer_verification_updated_preview', { customerId: user.id, verificationStatus: user.verificationStatus });
        return send(res, 200, { customer: publicUser(user), verificationStatus: user.verificationStatus, message: 'Preview verification status updated.' });
      }
      return send(res, 404, { error: 'Admin management route not found.' });
    }
    const deleteCustomerMatch = url.pathname.match(/^\/api\/admin\/customers\/([^/]+)$/);
    if (req.method === 'DELETE' && deleteCustomerMatch) {
      if (!adminAuthorized(req)) return send(res, 401, { error: 'Admin authorization required. Sign in to the staff portal again.' });
      const input = await body(req);
      const user = state.usersById.get(decodeURIComponent(deleteCustomerMatch[1]));
      if (!user) return send(res, 404, { error: 'Customer not found.' });
      if (String(input.confirmEmail || '').trim().toLowerCase() !== user.email.toLowerCase() || input.confirmation !== 'DELETE') return send(res, 400, { error: 'Enter the customer email and type DELETE to confirm permanent account removal.' });

      const removedOrderIds = new Set(state.orders.filter(order => order.customer?.email === user.email).map(order => order.id));
      const removedSellIds = new Set(state.sales.filter(order => order.customer?.email === user.email).map(order => order.id));
      const removedOrders = removedOrderIds.size;
      const removedSellRequests = removedSellIds.size;
      secureDocuments.removeAll(user.verificationDocuments || []);
      state.orders = state.orders.filter(order => order.customer?.email !== user.email);
      state.sales = state.sales.filter(order => order.customer?.email !== user.email);
      state.audit = state.audit.filter(event => {
        const detail = event.detail || {};
        return detail.userId !== user.id && detail.customerId !== user.id && !removedOrderIds.has(detail.id) && !removedOrderIds.has(detail.orderId) && !removedSellIds.has(detail.id);
      });
      state.users.delete(user.email);
      state.usersById.delete(user.id);
      for (const [sessionToken, session] of sessions) if (session.userId === user.id) sessions.delete(sessionToken);
      for (const customerViews of adminDocumentViews.values()) customerViews.delete(user.id);
      await log('admin_customer_personal_data_erased', { removedOrders, removedSellRequests });
      return send(res, 200, { ok: true, message: `The account and linked personal records were permanently removed from the active application store (${removedOrders} purchase records and ${removedSellRequests} sell records).`, removedOrders, removedSellRequests });
    }
    const walletDecisionMatch = url.pathname.match(/^\/api\/admin\/wallet-requests\/([^/]+)\/decision$/);
    if (req.method === 'POST' && walletDecisionMatch) {
      if (!adminAuthorized(req)) return send(res, 401, { error: 'Admin authorization required.' });
      const input = await body(req); const decision = String(input.decision || '');
      if (!['approve','reject'].includes(decision)) return send(res, 400, { error: 'Choose approve or reject.' });
      const transactionId = decodeURIComponent(walletDecisionMatch[1]);
      let owner = null, tx = null;
      for (const candidate of state.users.values()) { const found = walletTx(candidate, transactionId); if (found) { owner = candidate; tx = found; break; } }
      if (!owner || !tx || !['deposit','withdrawal'].includes(tx.type)) return send(res, 404, { error: 'Wallet request not found.' });
      if (tx.status !== 'pending_admin_review') return send(res, 409, { error: 'This wallet request has already been reviewed.' });
      ensureWallet(owner);
      const reviewer = adminSessions.get(adminTokenFromRequest(req))?.email || 'admin';
      if (decision === 'approve') {
        if (tx.type === 'deposit') owner.walletBalanceCents += tx.amountCents;
        tx.status = 'completed'; tx.reviewedAt = new Date().toISOString(); tx.reviewedBy = reviewer;
      } else {
        if (tx.type === 'withdrawal') owner.walletBalanceCents += tx.amountCents;
        tx.status = 'rejected'; tx.reviewedAt = new Date().toISOString(); tx.reviewedBy = reviewer;
      }
      await log(`wallet_${tx.type}_${decision}d`, { userId: owner.id, transactionId: tx.id, amountCents: tx.amountCents, reviewer });
      return send(res, 200, { transaction: tx, balanceCents: owner.walletBalanceCents, message: decision === 'approve' ? `${tx.type === 'deposit' ? 'Deposit credited' : 'Withdrawal approved'} successfully.` : `${tx.type === 'deposit' ? 'Deposit rejected; no balance was credited.' : 'Withdrawal rejected; reserved balance returned to the customer.'}` });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/summary') {
      if (!adminAuthorized(req)) return send(res, 401, { error: 'Admin authorization required. Sign in to the staff portal again.' });
      await releaseExpiredCryptoReservations();
      return send(res, 200, { mode: 'preview', inventory: products.map(pricing), prices: { source: priceSource, asOf: priceAsOf, metals: { ...spot } }, orders: state.orders, sellOrders: state.sales, walletRequests: [...state.users.values()].flatMap(user => (user.walletTransactions || []).filter(tx => ['deposit','withdrawal'].includes(tx.type) && tx.status === 'pending_admin_review').map(tx => ({ ...tx, customer: { id: user.id, name: user.name, email: user.email } }))).reverse(), customers: [...state.users.values()].map(user => ({ ...publicUser(user), verificationStatus: user.verificationStatus || 'not_started' })), customerCount: state.users.size, audit: [...state.audit].reverse() });
    }
    if (req.method === 'GET') return serveFile(req, res, url.pathname);
    return send(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    console.error('Request failed:', error.message);
    return send(res, 500, { error: 'The request could not be completed. Please try again.' });
  }
});
async function startServer() {
  await initializePersistentState();
  await releaseExpiredCryptoReservations();
  const expiryTimer = setInterval(() => {
    releaseExpiredCryptoReservations().catch(error => {
      console.error('Failed to persist expired crypto reservations:', error.message);
    });
  }, 30_000);
  expiryTimer.unref();
  server.listen(PORT, () => console.log(`Gold Investment preview running at http://localhost:${PORT}`));
}

startServer().catch(error => {
  console.error('Server startup failed; refusing to start without a valid Neon state:', error.message);
  process.exitCode = 1;
});
