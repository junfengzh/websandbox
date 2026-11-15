'use strict';
// Place facts read from a place page (search the name -> open the result -> read the facts):
// address, postcode, opening hours on a weekday, phone, website, category, cuisine, coordinates,
// county / London borough, peak elevation.
const L = require('./lib');

const ans = (spec, text) => ({ eval: { type: 'answer', answer: spec }, answer: text });
const view = (a) => L.startUrl(a);

// ---------------------------------------------------------------- opening hours (simple OSM forms only)
const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const DAY_NAME = { Mo: 'Monday', Tu: 'Tuesday', We: 'Wednesday', Th: 'Thursday', Fr: 'Friday', Sa: 'Saturday', Su: 'Sunday' };
const DSEL = '(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?';
const RULE = new RegExp(`^(${DSEL}(?:,${DSEL})*)\\s+(\\d\\d:\\d\\d)-(\\d\\d:\\d\\d)$`);
/** "Mo-Fr 08:00-18:00; Sa 09:00-17:00" -> {Mo: ['08:00', '18:00'], ...} | null (anything else) */
function parseHours(s) {
  if (!s || s.length > 120) return null;
  const out = {};
  for (const part of s.split(/\s*;\s*/)) {
    const m = RULE.exec(part.trim());
    if (!m) return null;
    const [, sel, o, c] = m;
    if (o >= c && c !== '00:00' && c !== '24:00') return null; // past midnight: skip
    if (+o.slice(0, 2) > 23 || +c.slice(0, 2) > 24) return null;
    for (const d of sel.split(',')) {
      const [a, b] = d.split('-');
      const i = DAYS.indexOf(a), j = b ? DAYS.indexOf(b) : i;
      if (j < i) return null;
      for (let k = i; k <= j; k++) out[DAYS[k]] = [o, c];
    }
  }
  return Object.keys(out).length ? out : null;
}
/** answer alternatives of a clock time: "09:00 |OR| 9:00 |OR| 9 am |OR| 9am |OR| 9:00 am ..." */
function timeAlts(t) {
  const [h, m] = t.split(':').map(Number);
  const alts = new Set([t, `${h}:${String(m).padStart(2, '0')}`]);
  if (h === 0 || h === 24) for (const x of ['midnight', '12 am', '12am', '12:00 am', '12:00am', '12 a.m.', '24:00', '00:00']) alts.add(x);
  else {
    const h12 = h % 12 === 0 ? 12 : h % 12, ap = h < 12 ? 'am' : 'pm', apd = h < 12 ? 'a.m.' : 'p.m.';
    const hm = m ? `${h12}:${String(m).padStart(2, '0')}` : null;
    for (const base of [hm, m ? null : String(h12), m ? null : `${h12}:00`].filter(Boolean)) {
      alts.add(`${base} ${ap}`); alts.add(`${base}${ap}`); alts.add(`${base} ${apd}`);
    }
    if (h === 12 && !m) alts.add('noon');
  }
  return [...alts].join(' |OR| ');
}

// ---------------------------------------------------------------- phones / websites / cuisines
function phoneAlts(ph) {
  const s = String(ph).trim();
  if (!/^\+\d{1,3}[\d \-().]{6,18}\d$/.test(s) || /[;,/]/.test(s)) return null;
  const alts = new Set([s]);
  const m = /^\+(1|44|65)[\s-]?(.*)$/.exec(s);
  if (!m) return null;
  const nat = m[2].trim();
  alts.add(m[1] === '44' ? '0' + nat.replace(/^\(?0\)?\s*/, '') : nat);
  const digits = (m[1] === '44' ? '0' : '') + nat.replace(/\D/g, '').replace(/^0/, '');
  if (digits.length >= 7) alts.add(digits);
  if (m[1] === '1' && digits.length === 10) alts.add(`(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`).add(`${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`);
  return { shown: s, alts: [...alts].join(' |OR| ') };
}
const SOCIAL = /(facebook|instagram|twitter|x\.com|linktr|yelp|tripadvisor|google|wix|squarespace|business\.site|opentable|ubereats|deliveroo|just-eat|doordash|grubhub)/i;
function siteHost(u) {
  try {
    const x = new URL(/^https?:/i.test(u) ? u : 'http://' + u);
    const h = x.hostname.toLowerCase().replace(/^www\d?\./, '');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h) || SOCIAL.test(h) || h.length > 40) return null;
    return h;
  } catch { return null; }
}
const CUISINE = { american: 'American', italian: 'Italian', chinese: 'Chinese', japanese: 'Japanese', indian: 'Indian', thai: 'Thai', mexican: 'Mexican',
  pizza: 'Pizza', burger: 'Burger', sushi: 'Sushi', french: 'French', korean: 'Korean', vietnamese: 'Vietnamese', greek: 'Greek', turkish: 'Turkish',
  lebanese: 'Lebanese', spanish: 'Spanish', seafood: 'Seafood', vegan: 'Vegan', vegetarian: 'Vegetarian', sandwich: 'Sandwich', chicken: 'Chicken',
  kebab: 'Kebab', noodle: 'Noodle', ramen: 'Ramen', bagel: 'Bagel', donut: 'Donut', malaysian: 'Malaysian', indonesian: 'Indonesian', caribbean: 'Caribbean',
  ethiopian: 'Ethiopian', peruvian: 'Peruvian', middle_eastern: 'Middle Eastern', mediterranean: 'Mediterranean', british: 'British',
  fish_and_chips: 'Fish and chips', steak_house: 'Steak', bubble_tea: 'Bubble tea', dim_sum: 'Dim sum', persian: 'Persian', polish: 'Polish',
  portuguese: 'Portuguese', brazilian: 'Brazilian', nepalese: 'Nepalese', pakistani: 'Pakistani', asian: 'Asian', tapas: 'Tapas', german: 'German',
  irish: 'Irish', african: 'African', bakery: 'Bakery', breakfast: 'Breakfast', barbecue: 'Barbecue', bbq: 'Barbecue', cantonese: 'Cantonese',
  taiwanese: 'Taiwanese', filipino: 'Filipino', jamaican: 'Jamaican', afghan: 'Afghan', georgian: 'Georgian', russian: 'Russian', hawaiian: 'Hawaiian',
  falafel: 'Falafel', crepe: 'Crepe', dessert: 'Dessert', ice_cream: 'Ice cream', juice: 'Juice', salad: 'Salad', soup: 'Soup', tea: 'Tea', hot_dog: 'Hot dog' };
// accepted wording of a cuisine (the place page shows "Cuisine: Middle Eastern")
const cuisineAlts = (k) => {
  const v = CUISINE[k];
  const alts = new Set([v, v.toLowerCase(), k.replace(/_/g, ' ')]);
  if (k === 'steak_house') alts.add('steakhouse').add('steak house');
  if (k === 'bbq' || k === 'barbecue') alts.add('bbq').add('barbecue');
  if (k === 'burger') alts.add('burgers');
  if (k === 'donut') alts.add('doughnut').add('donuts');
  return [...alts].join(' |OR| ');
};

// ---------------------------------------------------------------- category labels used for "what kind of place"
const KINDS = new Map(Object.entries({
  'amenity:cafe': 'Cafe |OR| café |OR| coffee', 'amenity:restaurant': 'Restaurant', 'amenity:fast_food': 'Fast Food |OR| fast-food',
  'amenity:pub': 'Pub', 'amenity:bar': 'Bar', 'tourism:museum': 'Museum', 'tourism:hotel': 'Hotel', 'amenity:pharmacy': 'Pharmacy |OR| chemist |OR| drugstore',
  'amenity:bank': 'Bank', 'amenity:library': 'Library', 'amenity:cinema': 'Cinema |OR| movie theater |OR| movie theatre', 'amenity:theatre': 'Theatre |OR| theater',
  'tourism:gallery': 'Gallery', 'shop:supermarket': 'Supermarket |OR| grocery', 'shop:bakery': 'Bakery', 'leisure:park': 'Park',
  'amenity:nightclub': 'Nightclub |OR| night club', 'amenity:ice_cream': 'Ice Cream', 'tourism:hostel': 'Hostel', 'amenity:place_of_worship': 'Place of Worship |OR| church |OR| mosque |OR| temple |OR| synagogue',
  'amenity:dentist': 'Dentist |OR| dental', 'shop:books': 'Book |OR| bookshop |OR| bookstore', 'shop:florist': 'Florist |OR| flower',
  'shop:hairdresser': 'Hairdresser |OR| hair salon |OR| barber', 'shop:clothes': 'Clothes |OR| clothing', 'shop:convenience': 'Convenience',
  'shop:butcher': 'Butcher', 'shop:jewelry': 'Jewelry |OR| jewellery |OR| jeweler |OR| jeweller', 'shop:hardware': 'Hardware', 'shop:optician': 'Optician |OR| optometrist |OR| eyewear',
  'leisure:fitness_centre': 'Fitness |OR| gym', 'amenity:veterinary': 'Veterinary |OR| vet', 'tourism:guest_house': 'Guest House |OR| guesthouse |OR| bed and breakfast',
  'shop:bicycle': 'Bicycle |OR| bike', 'shop:shoes': 'Shoe', 'shop:laundry': 'Laundry |OR| laundromat', 'shop:dry_cleaning': 'Dry Cleaning |OR| dry cleaner',
}));
const KIND_WORDS = /cafe|café|coffee|restaurant|food|pub|bar|museum|hotel|inn|pharmacy|chemist|drug|bank|librar|cinema|theat|gallery|market|grocer|bakery|bread|park|club|ice cream|gelato|hostel|church|chapel|mosque|temple|synagogue|cathedral|dental|dentist|book|flower|florist|hair|barber|salon|cloth|wear|fashion|boutique|convenience|deli|butcher|meat|jewel|hardware|optic|eye|vision|gym|fitness|yoga|vet|animal|pet|guest|b&b|bed|bike|cycle|shoe|laund|clean|kitchen|pizza|burger|grill|bistro|tavern|brew|taproom|lounge|diner|espresso|tea|bagel/i;

// ---------------------------------------------------------------- templates
module.exports = [
  {
    name: 'place-address', kind: 'read', skills: ['search', 'read-detail'], difficulty: 1, max: 55,
    phrasings: [
      'What is the street address of {{name}}{{where}}? Give the house number and street.',
      'Look up {{name}}{{where}} on the map and tell me its house number and street.',
      'Which house number and street is {{name}}{{where}} located at?',
    ],
    generate: (r) => L.loop(r, {
      max: 60, filter: (p) => p.housenumber && /^\d+[A-Za-z]?$/.test(p.housenumber) && p.street && L.nameOk(p.street),
      make: (p, a) => ({ slots: { name: p.name, where: L.where(p) }, start_url: view(a), ...ans({ must_include: [p.housenumber, L.streetAlts(p.street)] }, `${p.housenumber} ${p.street}`) }),
    }),
  },
  {
    name: 'place-postcode', kind: 'read', skills: ['search', 'read-detail'], difficulty: 1, max: 50,
    phrasings: [
      'What is the postcode of {{name}}{{where}}?',
      'I need to mail something to {{name}}{{where}}. What postal code does the map list for it?',
      'Find {{name}}{{where}} on the map. What is its postcode?',
    ],
    generate: (r) => L.loop(r, {
      max: 55, filter: () => true,
      make: (p, a) => {
        const f = L.fmt(p);
        const pc = f && f.address && f.address.postcode;
        if (!pc || !/^[A-Z0-9]{2,5}( ?[A-Z0-9]{3})?$/i.test(pc) || /\d{5}-\d{4}/.test(pc)) return null;
        const t = ans({ must_include: [pc] }, pc);
        t.eval.answer_sql = `SELECT coalesce(p.postcode, c.postcode) FROM places p LEFT JOIN combos c ON c.id = p.combo WHERE p.id = ${p.id}`;
        return { slots: { name: p.name, where: L.where(p) }, start_url: view(a), ...t };
      },
    }),
  },
  {
    name: 'place-hours', kind: 'read', skills: ['search', 'read-detail'], difficulty: 2, max: 50,
    phrasings: [
      'According to the map, what are the opening hours of {{name}}{{where}} on {{day}}? Give the opening and the closing time.',
      'When does {{name}}{{where}} open and close on a {{day}}?',
      'I want to visit {{name}}{{where}} on {{day}}. From what time to what time is it open?',
    ],
    generate: (r) => L.loop(r, {
      max: 55, filter: (p) => p.tags.opening_hours && parseHours(p.tags.opening_hours),
      make: (p, a) => {
        const h = parseHours(p.tags.opening_hours);
        const days = DAYS.filter((d) => h[d]);
        const d = r.pick(days);
        const [o, c] = h[d];
        return { slots: { name: p.name, where: L.where(p), day: DAY_NAME[d] }, start_url: view(a),
          changes: [`opening_hours "${p.tags.opening_hours}" -> ${DAY_NAME[d]} ${o}-${c}`], ...ans({ must_include: [timeAlts(o), timeAlts(c)] }, `${o} to ${c}`) };
      },
    }),
  },
  {
    name: 'place-phone', kind: 'read', skills: ['search', 'read-detail'], difficulty: 1, max: 50,
    phrasings: [
      'What is the phone number of {{name}}{{where}}?',
      'I want to call {{name}}{{where}}. Which phone number does the map show for it?',
      'Find the contact phone number of {{name}}{{where}} on the map.',
    ],
    generate: (r) => L.loop(r, {
      max: 55, filter: (p) => phoneAlts(p.tags.phone || p.tags['contact:phone']),
      make: (p, a) => { const ph = phoneAlts(p.tags.phone || p.tags['contact:phone']); return { slots: { name: p.name, where: L.where(p) }, start_url: view(a), ...ans({ must_include: [ph.alts] }, ph.shown) }; },
    }),
  },
  {
    name: 'place-website', kind: 'read', skills: ['search', 'read-detail'], difficulty: 1, max: 50,
    phrasings: [
      'What is the website of {{name}}{{where}}, according to the map?',
      'Which web address is listed for {{name}}{{where}}?',
      'Find {{name}}{{where}} on the map and tell me the domain of its website.',
    ],
    generate: (r) => {
      const hosts = new Set();
      return L.loop(r, {
        max: 55, filter: (p) => !p.tags.brand && siteHost(p.tags.website || p.tags['contact:website'] || p.tags.url || ''),
        make: (p, a) => {
          const h = siteHost(p.tags.website || p.tags['contact:website'] || p.tags.url);
          if (hosts.has(h)) return null; // one task per site (chains share domains)
          hosts.add(h);
          return { slots: { name: p.name, where: L.where(p) }, start_url: view(a), ...ans({ must_include: [h] }, h) };
        },
      });
    },
  },
  {
    name: 'place-category', kind: 'read', skills: ['search', 'read-detail'], difficulty: 1, max: 50,
    phrasings: [
      'What kind of place is {{name}}{{where}}, according to the map (e.g. cafe, museum, shop type)?',
      'Look up {{name}}{{where}}. What type of place does the map say it is?',
      'Is {{name}}{{where}} a restaurant, a shop, a museum or something else? Tell me its category on the map.',
    ],
    generate: (r) => L.loop(r, {
      max: 55, filter: (p) => KINDS.has(`${p.class}:${p.type}`) && !KIND_WORDS.test(p.name),
      make: (p, a) => ({ slots: { name: p.name, where: L.where(p) }, start_url: view(a), ...ans({ must_include: [KINDS.get(`${p.class}:${p.type}`)] }, L.typeLabel(p)) }),
    }),
  },
  {
    name: 'place-cuisine', kind: 'read', skills: ['search', 'read-detail'], difficulty: 1, max: 50,
    phrasings: [
      'What cuisine does {{name}}{{where}} serve, according to the map?',
      'I am thinking of eating at {{name}}{{where}}. What type of cuisine is it?',
      'Which cuisine is listed on the map for {{name}}{{where}}?',
    ],
    generate: (r) => L.loop(r, {
      max: 55, filter: (p) => ['restaurant', 'fast_food', 'cafe'].includes(p.type) && p.class === 'amenity' && CUISINE[p.tags.cuisine]
        && !new RegExp(CUISINE[p.tags.cuisine].split(' ')[0], 'i').test(p.name) && !KIND_WORDS.test(p.name.replace(/restaurant|cafe|café|food|grill|kitchen|bistro|diner/gi, '')),
      make: (p, a) => ({ slots: { name: p.name, where: L.where(p) }, start_url: view(a), ...ans({ must_include: [cuisineAlts(p.tags.cuisine)] }, CUISINE[p.tags.cuisine]) }),
    }),
  },
  {
    name: 'place-coords', kind: 'read', skills: ['search', 'read-detail'], difficulty: 1, max: 50,
    phrasings: [
      'What are the coordinates (latitude and longitude) of {{name}}{{where}}?',
      'Give me the latitude and longitude of {{name}}{{where}} in decimal degrees.',
      'Find {{name}}{{where}} on the map and report its GPS coordinates.',
    ],
    generate: (r) => L.loop(r, {
      max: 55, filter: () => true,
      make: (p, a) => ({ slots: { name: p.name, where: L.where(p) }, start_url: view(a),
        ...ans({ numeric: [{ value: +p.lat.toFixed(6), unit: 'deg', tol_abs: 0.0015 }, { value: +p.lon.toFixed(6), unit: 'deg', tol_abs: 0.0015 }] }, L.coordsText(p.lat, p.lon)) }),
    }),
  },
  {
    name: 'place-area', kind: 'read', skills: ['search', 'read-detail'], difficulty: 2, max: 50,
    phrasings: [
      'In which {{unit}} is {{name}}{{where}} located?',
      'Look up {{name}}{{where}} on the map. Which {{unit}} is it in?',
      'Tell me the {{unit}} that {{name}}{{where}} belongs to, according to its address on the map.',
    ],
    generate: (r) => L.loop(r, {
      max: 55, areas: L.AREAS.filter((a) => a.id !== 'sf' && a.id !== 'singapore'), filter: () => true,
      make: (p, a) => {
        const f = L.fmt(p);
        const ad = f.address || {};
        let unit, v, short;
        if (ad.country_code === 'gb') {
          v = ad.city;
          if (!v || !/^(London Borough of|Royal Borough of|City of) /.test(v)) return null;
          short = v === 'City of London' ? v : v.replace(/^(London Borough of|Royal Borough of|City of) /, '');
          unit = 'London borough';
        } else {
          v = ad.county;
          if (!v || !/ County$/.test(v)) return null;
          short = v.replace(/ County$/, '');
          unit = 'county';
        }
        const city = L.cityOf(p) || '';
        if (L.norm(p.name).includes(L.norm(short)) || L.norm(city).includes(L.norm(short)) || L.norm(short).includes(L.norm(city) || '#')) return null; // not the city's own name
        return { slots: { name: p.name, where: L.where(p), unit }, start_url: view(a), ...ans({ must_include: [short] }, v) };
      },
    }),
  },
  {
    name: 'peak-elevation', kind: 'read', skills: ['search', 'read-detail'], difficulty: 1, max: 50,
    phrasings: [
      'How high is {{name}}? Give its elevation as listed on the map.',
      'What is the elevation of the summit {{name}}, according to the map?',
      'Look up the peak {{name}} on the map. What is its elevation?',
    ],
    generate: async function* gen(r) {
      // summits of the US Northeast with a numeric ele tag; the view is the nearest sampling area
      const rows = L.all(`SELECT * FROM places WHERE class = 'natural' AND type = 'peak' AND name IS NOT NULL AND extratags LIKE '%"ele"%' ORDER BY id`);
      let n = 0;
      for (const row of r.shuffle(rows)) {
        if (n >= 55) break;
        const tags = JSON.parse(row.extratags);
        if (!/^\d+(\.\d+)?$/.test(String(tags.ele)) || +tags.ele < 20 || !L.nameOk(row.name)) continue;
        const a = L.AREAS.reduce((b, x) => (L.hav(row.lat, row.lon, x.lat, x.lon) < L.hav(row.lat, row.lon, b.lat, b.lon) ? x : b));
        const p = { ...row, area: a.id, tags };
        if (!L.unambiguous(p)) continue;
        n++;
        const ele = +tags.ele;
        yield { slots: { name: p.name }, start_url: L.startUrl(a), ...ans({ numeric: { value: ele, unit: 'm', tol_pct: 1, tol_abs: 1 } }, `${ele} m`) };
      }
    },
  },
];
module.exports.parseHours = parseHours;
module.exports.timeAlts = timeAlts;
module.exports.phoneAlts = phoneAlts;
module.exports.KINDS = KINDS;
