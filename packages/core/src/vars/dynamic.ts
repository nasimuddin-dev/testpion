import { randomInt, randomUUID } from 'node:crypto';
import { MORE_GENERATORS } from './dynamic-more.js';

/**
 * Dynamic variables: `{{$guid}}`, `{{$timestamp}}`, `{{$randomFirstName}}` … a new value every time they
 * are used. The names are Postman's, so collections imported from Postman send what they sent there.
 * Fake data only (emails use example.test, phone numbers the 555 range); nothing is looked up.
 */
const pick = <T>(list: readonly T[]): T => list[randomInt(0, list.length)]!;
const int = (min: number, max: number) => randomInt(min, max + 1);
const hex = (n: number) => Array.from({ length: n }, () => '0123456789abcdef'[randomInt(0, 16)]).join('');
const alnum = (n: number) => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[randomInt(0, 36)]).join('');

const FIRST = ['Ada', 'Alan', 'Grace', 'Linus', 'Margaret', 'Dennis', 'Barbara', 'Ken', 'Radia', 'Tim', 'Katherine', 'Guido', 'Hedy', 'Bjarne', 'Frances', 'James', 'Mary', 'Noah', 'Olivia', 'Sofia', 'Liam', 'Emma', 'Mateo', 'Aisha', 'Yuki', 'Ravi', 'Chen', 'Fatima'];
const LAST = ['Lovelace', 'Turing', 'Hopper', 'Torvalds', 'Hamilton', 'Ritchie', 'Liskov', 'Thompson', 'Perlman', 'Berners-Lee', 'Johnson', 'Rossum', 'Lamarr', 'Stroustrup', 'Allen', 'Gosling', 'Smith', 'Garcia', 'Kim', 'Nguyen', 'Patel', 'Müller', 'Silva', 'Okafor', 'Tanaka', 'Rossi'];
const CITIES = ['Amsterdam', 'Austin', 'Bangalore', 'Berlin', 'Boston', 'Cape Town', 'Dublin', 'Lisbon', 'London', 'Madrid', 'Melbourne', 'Montreal', 'Nairobi', 'Oslo', 'Paris', 'Seattle', 'Seoul', 'Singapore', 'Tokyo', 'Toronto', 'Warsaw', 'Zurich'];
const COUNTRIES: Array<[string, string]> = [['Australia', 'AU'], ['Brazil', 'BR'], ['Canada', 'CA'], ['France', 'FR'], ['Germany', 'DE'], ['India', 'IN'], ['Japan', 'JP'], ['Kenya', 'KE'], ['Netherlands', 'NL'], ['Norway', 'NO'], ['Portugal', 'PT'], ['Singapore', 'SG'], ['South Korea', 'KR'], ['Spain', 'ES'], ['Sweden', 'SE'], ['United Kingdom', 'GB'], ['United States', 'US']];
const STREETS = ['Maple Street', 'Oak Avenue', 'Pine Road', 'Cedar Lane', 'Elm Street', 'Harbor Way', 'Station Road', 'Market Street', 'Park Avenue', 'Mill Lane'];
const WORDS = ['alpha', 'bright', 'cloud', 'delta', 'ember', 'forest', 'glacier', 'harbor', 'island', 'jungle', 'kernel', 'lantern', 'meadow', 'nebula', 'orbit', 'pixel', 'quartz', 'river', 'signal', 'timber', 'umbra', 'vector', 'willow', 'zenith'];
const LOREM = ['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit', 'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore', 'magna', 'aliqua', 'enim', 'minim', 'veniam', 'quis', 'nostrud'];
const COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'indigo', 'violet', 'pink', 'brown', 'gray', 'black', 'white', 'gold', 'silver'];
const JOBS = ['Software Engineer', 'Product Manager', 'Data Scientist', 'Designer', 'QA Engineer', 'DevOps Engineer', 'Technical Writer', 'Support Specialist', 'Sales Manager', 'Accountant'];
const DEPARTMENTS = ['Engineering', 'Sales', 'Marketing', 'Finance', 'Support', 'Legal', 'Operations', 'Research', 'Design', 'People'];
const COMPANIES = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Stark Industries', 'Wayne Enterprises', 'Soylent', 'Vandelay Industries', 'Wonka'];
const SUFFIXES = ['Inc', 'LLC', 'Ltd', 'Group', 'GmbH', 'Co'];
const ADJECTIVES = ['Ergonomic', 'Handcrafted', 'Refined', 'Sleek', 'Rustic', 'Smart', 'Practical', 'Durable', 'Compact', 'Premium'];
const MATERIALS = ['Steel', 'Wooden', 'Cotton', 'Granite', 'Rubber', 'Plastic', 'Concrete', 'Glass', 'Bronze', 'Leather'];
const PRODUCTS = ['Chair', 'Table', 'Keyboard', 'Lamp', 'Backpack', 'Bottle', 'Headphones', 'Mug', 'Notebook', 'Watch'];
const CURRENCIES: Array<[string, string, string]> = [['USD', 'US Dollar', '$'], ['EUR', 'Euro', '€'], ['GBP', 'Pound Sterling', '£'], ['JPY', 'Yen', '¥'], ['INR', 'Indian Rupee', '₹'], ['CAD', 'Canadian Dollar', '$'], ['CHF', 'Swiss Franc', 'CHF']];
const TLDS = ['com', 'net', 'org', 'io', 'dev', 'app', 'test'];
const MIME: Array<[string, string]> = [['application/json', 'json'], ['text/plain', 'txt'], ['text/csv', 'csv'], ['image/png', 'png'], ['image/jpeg', 'jpg'], ['application/pdf', 'pdf'], ['application/xml', 'xml'], ['application/zip', 'zip']];
const LOCALES = ['en', 'en-US', 'en-GB', 'fr', 'de', 'es', 'ja', 'pt-BR', 'nl', 'sv', 'ko', 'zh'];
const AGENTS = ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'curl/8.9.1'];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const words = (n: number, from: readonly string[] = WORDS) => Array.from({ length: n }, () => pick(from)).join(' ');
const sentence = () => {
  const s = words(int(6, 12), LOREM);
  return `${s[0]!.toUpperCase()}${s.slice(1)}.`;
};
const day = (ms: number) => new Date(Date.now() + ms).toISOString();

/** name → [description, generator] */
const GENERATORS: Record<string, [string, () => string | number | boolean]> = {
  $guid: ['A random UUID', () => randomUUID()],
  $uuid: ['A random UUID', () => randomUUID()],
  $randomUUID: ['A random UUID', () => randomUUID()],
  $timestamp: ['Unix time in seconds', () => Math.floor(Date.now() / 1000)],
  $timestampMs: ['Unix time in milliseconds', () => Date.now()],
  $isoTimestamp: ['The current time, ISO-8601', () => new Date().toISOString()],
  $randomInt: ['A whole number from 0 to 1000 ($randomInt(min,max) for a range)', () => int(0, 1000)],
  $randomBoolean: ['true or false', () => randomInt(0, 2) === 1],
  $randomAlphaNumeric: ['One letter or digit', () => alnum(1)],
  $randomPassword: ['A 15-character password', () => alnum(15)],
  $randomColor: ['A color name', () => pick(COLORS)],
  $randomHexColor: ['A hex color like #3fa2c0', () => `#${hex(6)}`],
  $randomAbbreviation: ['An abbreviation like API', () => pick(['API', 'HTTP', 'JSON', 'SQL', 'TCP', 'XML', 'CSS', 'SSL', 'RAM', 'PDF'])],
  $randomIP: ['An IPv4 address', () => `${int(1, 223)}.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`],
  $randomIPV6: ['An IPv6 address', () => Array.from({ length: 8 }, () => hex(4)).join(':')],
  $randomMACAddress: ['A MAC address', () => Array.from({ length: 6 }, () => hex(2)).join(':')],
  $randomProtocol: ['http or https', () => pick(['http', 'https'])],
  $randomSemver: ['A version like 2.4.1', () => `${int(0, 9)}.${int(0, 20)}.${int(0, 30)}`],
  $randomLocale: ['A locale like en-GB', () => pick(LOCALES)],
  $randomUserAgent: ['A browser user agent', () => pick(AGENTS)],
  $randomFirstName: ['A first name', () => pick(FIRST)],
  $randomLastName: ['A last name', () => pick(LAST)],
  $randomFullName: ['A full name', () => `${pick(FIRST)} ${pick(LAST)}`],
  $randomNamePrefix: ['A title like Dr.', () => pick(['Mr.', 'Ms.', 'Mrs.', 'Dr.', 'Prof.'])],
  $randomNameSuffix: ['A suffix like Jr.', () => pick(['Jr.', 'Sr.', 'II', 'III', 'PhD'])],
  $randomJobTitle: ['A job title', () => pick(JOBS)],
  $randomJobArea: ['A department', () => pick(DEPARTMENTS)],
  $randomPhoneNumber: ['A fictional phone number (555)', () => `555-${int(100, 999)}-${int(1000, 9999)}`],
  $randomPhoneNumberExt: ['A phone number with extension', () => `555-${int(100, 999)}-${int(1000, 9999)} x${int(10, 999)}`],
  $randomCity: ['A city', () => pick(CITIES)],
  $randomStreetName: ['A street name', () => pick(STREETS)],
  $randomStreetAddress: ['A street address', () => `${int(1, 9999)} ${pick(STREETS)}`],
  $randomCountry: ['A country', () => pick(COUNTRIES)[0]],
  $randomCountryCode: ['A two-letter country code', () => pick(COUNTRIES)[1]],
  $randomLatitude: ['A latitude', () => (Math.random() * 180 - 90).toFixed(6)],
  $randomLongitude: ['A longitude', () => (Math.random() * 360 - 180).toFixed(6)],
  $randomPrice: ['A price like 42.99', () => (int(100, 99999) / 100).toFixed(2)],
  $randomCurrencyCode: ['A currency code like EUR', () => pick(CURRENCIES)[0]],
  $randomCurrencyName: ['A currency name', () => pick(CURRENCIES)[1]],
  $randomCurrencySymbol: ['A currency symbol', () => pick(CURRENCIES)[2]],
  $randomBankAccount: ['An 8-digit account number', () => String(int(10_000_000, 99_999_999))],
  $randomCompanyName: ['A company name', () => `${pick(COMPANIES)} ${pick(SUFFIXES)}`],
  $randomCompanySuffix: ['Inc, LLC, Ltd …', () => pick(SUFFIXES)],
  $randomDepartment: ['A department', () => pick(DEPARTMENTS)],
  $randomProductName: ['A product name', () => `${pick(ADJECTIVES)} ${pick(MATERIALS)} ${pick(PRODUCTS)}`],
  $randomProduct: ['A product', () => pick(PRODUCTS)],
  $randomProductAdjective: ['A product adjective', () => pick(ADJECTIVES)],
  $randomProductMaterial: ['A material', () => pick(MATERIALS)],
  $randomDateFuture: ['A date in the next year', () => day(int(1, 365) * 86_400_000)],
  $randomDatePast: ['A date in the past year', () => day(-int(1, 365) * 86_400_000)],
  $randomDateRecent: ['A date in the past few days', () => day(-int(1, 3 * 86_400) * 1000)],
  $randomWeekday: ['A weekday', () => pick(WEEKDAYS)],
  $randomMonth: ['A month', () => pick(MONTHS)],
  $randomDomainWord: ['A word for a domain', () => pick(WORDS)],
  $randomDomainSuffix: ['A top-level domain', () => pick(TLDS)],
  $randomDomainName: ['A domain name (example.* style)', () => `${pick(WORDS)}.example.${pick(TLDS)}`],
  $randomEmail: ['An email address at example.test', () => `${pick(FIRST).toLowerCase()}.${pick(LAST).toLowerCase().replace(/[^a-z]/g, '')}${int(1, 999)}@example.test`],
  $randomExampleEmail: ['An email address at example.com', () => `${pick(FIRST).toLowerCase()}${int(1, 999)}@example.com`],
  $randomUserName: ['A user name', () => `${pick(FIRST).toLowerCase()}_${pick(WORDS)}${int(1, 99)}`],
  $randomUrl: ['A URL', () => `https://${pick(WORDS)}.example.com/${pick(WORDS)}`],
  $randomWord: ['A word', () => pick(WORDS)],
  $randomWords: ['A few words', () => words(int(2, 5))],
  $randomLoremWord: ['A lorem ipsum word', () => pick(LOREM)],
  $randomLoremWords: ['A few lorem ipsum words', () => words(3, LOREM)],
  $randomLoremSentence: ['A lorem ipsum sentence', () => sentence()],
  $randomLoremSentences: ['A few sentences', () => Array.from({ length: int(2, 4) }, sentence).join(' ')],
  $randomLoremParagraph: ['A paragraph', () => Array.from({ length: int(4, 6) }, sentence).join(' ')],
  $randomLoremSlug: ['A slug like lorem-ipsum-dolor', () => words(3, LOREM).replace(/ /g, '-')],
  $randomCatchPhrase: ['A catch phrase', () => `${pick(ADJECTIVES)} ${pick(WORDS)} ${pick(['platform', 'solution', 'framework', 'service'])}`],
  $randomFileName: ['A file name', () => `${pick(WORDS)}.${pick(MIME)[1]}`],
  $randomFileExt: ['A file extension', () => pick(MIME)[1]],
  $randomFileType: ['A file type', () => pick(['image', 'text', 'application', 'audio', 'video'])],
  $randomMimeType: ['A MIME type', () => pick(MIME)[0]],
  $randomImageUrl: ['An image URL (placeholder)', () => `https://picsum.photos/${int(2, 8) * 100}/${int(2, 6) * 100}`],
  $randomAvatarImage: ['An avatar image URL (placeholder)', () => `https://i.pravatar.cc/${int(1, 70)}`],
};

/** Dynamic variable names with a description (for completion and docs). */
export const DYNAMIC_VARIABLES: Array<{ name: string; description: string }> = Object.entries({ ...GENERATORS, ...MORE_GENERATORS }).map(([name, [description]]) => ({ name, description }));

/** A fresh value of a dynamic variable, or undefined when the name isn't one. */
export function dynamicValue(name: string): string | number | boolean | undefined {
  const g = GENERATORS[name] ?? MORE_GENERATORS[name];
  if (g) return g[1]();
  const range = /^\$randomInt\((-?\d+)\s*,\s*(-?\d+)\)$/.exec(name);
  if (range) return int(Number(range[1]), Number(range[2]));
  return undefined;
}
