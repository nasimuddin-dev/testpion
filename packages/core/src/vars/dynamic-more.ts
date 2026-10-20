import { randomInt } from 'node:crypto';

/**
 * The rest of Postman's documented dynamic variables (images, finance, business phrases, databases, grammar, files,
 * jobs, text, directions), so a collection imported from Postman or Bruno (which adopted its names) renders everything
 * it used there. Fake data only; images are placeholder URLs, bank and card values are not valid for any account.
 * https://learning.postman.com/docs/tests-and-scripts/write-scripts/variables-list/
 */
const pick = <T>(list: readonly T[]): T => list[randomInt(0, list.length)]!;
const int = (min: number, max: number) => randomInt(min, max + 1);
const digits = (n: number) => Array.from({ length: n }, () => String(randomInt(0, 10))).join('');
const upper = (n: number) => Array.from({ length: n }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[randomInt(0, 26)]).join('');
const alnum = (n: number, set = 'abcdefghijklmnopqrstuvwxyz0123456789') => Array.from({ length: n }, () => set[randomInt(0, set.length)]).join('');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

type G = [string, () => string | number | boolean];

const image = (topic: string): G => [`A placeholder ${topic} image URL`, () => `https://loremflickr.com/640/480/${topic}?lock=${int(1, 9999)}`];

const BS_ADJ = ['implement', 'utilize', 'integrate', 'streamline', 'optimize', 'evolve', 'transform', 'embrace', 'enable', 'orchestrate'];
const BS_BUZZ = ['synergistic', 'disintermediate', 'monetize', 'leverage', 'incentivize', 'architect', 'reinvent', 'harness', 'repurpose', 'whiteboard'];
const BS_NOUN = ['paradigms', 'markets', 'partnerships', 'infrastructures', 'platforms', 'initiatives', 'channels', 'eyeballs', 'communities', 'ROI'];
const CP_ADJ = ['Adaptive', 'Advanced', 'Ameliorated', 'Automated', 'Balanced', 'Centralized', 'Cloned', 'Configurable', 'Cross-platform', 'Customizable'];
const CP_DESC = ['24 hour', 'multi-state', 'background', 'high-level', 'bottom-line', 'fault-tolerant', 'full-range', 'interactive', 'upward-trending', 'well-modulated'];
const CP_NOUN = ['ability', 'access', 'adapter', 'algorithm', 'alliance', 'analyzer', 'application', 'approach', 'architecture', 'archive'];
const DB_COL = ['id', 'title', 'name', 'email', 'phone', 'token', 'group', 'category', 'password', 'comment', 'avatar', 'status', 'createdAt', 'updatedAt'];
const DB_TYPE = ['int', 'varchar', 'text', 'date', 'datetime', 'tinyint', 'time', 'timestamp', 'smallint', 'mediumint', 'bigint', 'decimal', 'float', 'double', 'real', 'bit', 'boolean', 'serial', 'blob', 'binary', 'enum', 'set', 'geometry', 'point'];
const DB_COLLATION = ['utf8_unicode_ci', 'utf8_general_ci', 'utf8_bin', 'ascii_bin', 'ascii_general_ci', 'cp1250_bin', 'cp1250_general_ci'];
const DB_ENGINE = ['ARCHIVE', 'CSV', 'InnoDB', 'MEMORY', 'MRG_MYISAM', 'MyISAM', 'BLACKHOLE', 'FEDERATED'];
const ADJECTIVE = ['quick', 'lazy', 'bright', 'quiet', 'ancient', 'clever', 'brave', 'gentle', 'rapid', 'silent', 'sturdy', 'vivid'];
const NOUN = ['river', 'engine', 'garden', 'signal', 'harbor', 'lantern', 'meadow', 'orbit', 'pixel', 'vector', 'window', 'bridge'];
const VERB = ['connect', 'compile', 'deploy', 'navigate', 'render', 'synchronize', 'transmit', 'validate', 'archive', 'calculate', 'generate', 'index'];
const FILE_EXT: Array<[string, string]> = [['application/json', 'json'], ['text/plain', 'txt'], ['text/csv', 'csv'], ['image/png', 'png'], ['image/jpeg', 'jpg'], ['application/pdf', 'pdf'], ['video/mp4', 'mp4'], ['audio/mpeg', 'mp3'], ['application/zip', 'zip'], ['text/html', 'html']];
const JOB_DESC = ['Lead', 'Senior', 'Direct', 'Corporate', 'Dynamic', 'Future', 'Product', 'National', 'Regional', 'Internal'];
const JOB_TYPE = ['Supervisor', 'Associate', 'Executive', 'Liaison', 'Officer', 'Manager', 'Engineer', 'Specialist', 'Director', 'Coordinator'];
const LOREM = ['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit', 'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore', 'magna', 'aliqua'];
const sentence = () => cap(Array.from({ length: int(6, 12) }, () => pick(LOREM)).join(' ')) + '.';
const DIRS = ['North', 'East', 'South', 'West', 'Northeast', 'Northwest', 'Southeast', 'Southwest'];
const DIR_ABBR = ['N', 'E', 'S', 'W', 'NE', 'NW', 'SE', 'SW'];
const STREET_SUFFIX = ['Alley', 'Avenue', 'Boulevard', 'Circle', 'Court', 'Drive', 'Lane', 'Parkway', 'Place', 'Road', 'Street', 'Way'];
const TX = ['deposit', 'withdrawal', 'payment', 'invoice'];
const ACCOUNT = ['Checking Account', 'Savings Account', 'Money Market Account', 'Investment Account', 'Home Loan Account', 'Credit Card Account', 'Personal Loan Account', 'Auto Loan Account'];
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export const MORE_GENERATORS: Record<string, G> = {
  $randomAbstractImage: image('abstract'),
  $randomAnimalsImage: image('animals'),
  $randomBusinessImage: image('business'),
  $randomCatsImage: image('cats'),
  $randomCityImage: image('city'),
  $randomFoodImage: image('food'),
  $randomNightlifeImage: image('nightlife'),
  $randomFashionImage: image('fashion'),
  $randomPeopleImage: image('people'),
  $randomNatureImage: image('nature'),
  $randomSportsImage: image('sports'),
  $randomTransportImage: image('transport'),
  // a 1x1 PNG, the smallest valid image
  $randomImageDataUri: ['A tiny inline PNG as a data URI', () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='],
  $randomBankAccountName: ['A bank account name', () => pick(ACCOUNT)],
  $randomBankAccountBic: ['A BIC / SWIFT code (not a real bank)', () => `${upper(4)}${upper(2)}${upper(2)}${alnum(3, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')}`],
  $randomBankAccountIban: ['An IBAN-shaped number (the check digits are not valid)', () => `${pick(['DE', 'FR', 'GB', 'NL', 'ES'])}${digits(2)}${upper(4)}${digits(14)}`],
  $randomCreditCardMask: ['The last four digits of a card, like 1234', () => digits(4)],
  $randomBitcoin: ['A Bitcoin-address-shaped string', () => `${pick(['1', '3'])}${alnum(int(26, 33), BASE58)}`],
  $randomTransactionType: ['A transaction type: deposit, withdrawal, payment, invoice', () => pick(TX)],
  $randomBs: ['A business phrase', () => `${pick(BS_ADJ)} ${pick(BS_BUZZ)} ${pick(BS_NOUN)}`],
  $randomBsAdjective: ['A business-speak adjective', () => pick(BS_ADJ)],
  $randomBsBuzz: ['A business buzzword', () => pick(BS_BUZZ)],
  $randomBsNoun: ['A business-speak noun', () => pick(BS_NOUN)],
  $randomCatchPhraseAdjective: ['A catch-phrase adjective', () => pick(CP_ADJ)],
  $randomCatchPhraseDescriptor: ['A catch-phrase descriptor', () => pick(CP_DESC)],
  $randomCatchPhraseNoun: ['A catch-phrase noun', () => pick(CP_NOUN)],
  $randomDatabaseColumn: ['A database column name', () => pick(DB_COL)],
  $randomDatabaseType: ['A database column type', () => pick(DB_TYPE)],
  $randomDatabaseCollation: ['A database collation', () => pick(DB_COLLATION)],
  $randomDatabaseEngine: ['A database engine', () => pick(DB_ENGINE)],
  $randomAdjective: ['An adjective', () => pick(ADJECTIVE)],
  $randomNoun: ['A noun', () => pick(NOUN)],
  $randomVerb: ['A verb', () => pick(VERB)],
  $randomIngverb: ['A verb ending in -ing', () => `${pick(VERB).replace(/e$/, '')}ing`],
  $randomPhrase: ['A short phrase', () => `${pick(ADJECTIVE)} ${pick(NOUN)} ${pick(VERB)}s`],
  $randomCommonFileName: ['A file name with a common extension', () => `${pick(NOUN)}_${pick(ADJECTIVE)}.${pick(FILE_EXT)[1]}`],
  $randomCommonFileType: ['A common file type (MIME)', () => pick(FILE_EXT)[0]],
  $randomCommonFileExt: ['A common file extension', () => pick(FILE_EXT)[1]],
  $randomFilePath: ['A file path', () => `/${pick(NOUN)}/${pick(NOUN)}/${pick(ADJECTIVE)}.${pick(FILE_EXT)[1]}`],
  $randomDirectoryPath: ['A directory path', () => `/${pick(NOUN)}/${pick(NOUN)}`],
  $randomJobDescriptor: ['A job title descriptor', () => pick(JOB_DESC)],
  $randomJobType: ['A job title type', () => pick(JOB_TYPE)],
  $randomLoremLines: ['Several lines of lorem ipsum', () => Array.from({ length: int(2, 4) }, sentence).join('\n')],
  $randomLoremText: ['A paragraph of lorem ipsum', () => Array.from({ length: int(3, 5) }, sentence).join(' ')],
  $randomDirectionAbbreviation: ['A compass direction abbreviation (N, SE …)', () => pick(DIR_ABBR)],
  $randomCardinalDirection: ['North, East, South or West', () => pick(DIRS.slice(0, 4))],
  $randomOrdinalDirection: ['Northeast, Northwest, Southeast or Southwest', () => pick(DIRS.slice(4))],
  $randomStreetSuffix: ['A street suffix (Avenue, Road …)', () => pick(STREET_SUFFIX)],
  $randomZipCode: ['A five-digit ZIP code', () => digits(5)],
  $randomPort: ['A network port number', () => int(1024, 65535)],
};
