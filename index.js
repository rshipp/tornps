const sqlite = require('better-sqlite3');
const Discord = require('discord.js');
const moment = require('moment-timezone');
const predictions = require('./predictions.js');

const CONFIG = require('./config.json');

const db = new sqlite('.data/data.db');
const client = new Discord.Client();

// MUST be US, because ACNH weeks start on Sunday.
moment.locale('en-US');
moment.tz.setDefault(CONFIG.tz);


/**
 * DB setup.
 */
db.prepare(`CREATE TABLE IF NOT EXISTS sell_price (
  user_id INTEGER NOT NULL,
  week INTEGER NOT NULL,
  price INTEGER NOT NULL,
  PRIMARY KEY(user_id, week) ON CONFLICT REPLACE
);`).run();
 
db.prepare(`CREATE TABLE IF NOT EXISTS buy_price (
  user_id INTEGER NOT NULL,
  week INTEGER NOT NULL,
  day INTEGER NOT NULL,
  night INTEGER NOT NULL,
  price INTEGER NOT NULL,
  PRIMARY KEY(user_id, week, day, night) ON CONFLICT REPLACE
);`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS pattern (
  user_id INTEGER NOT NULL,
  week INTEGER NOT NULL,
  pattern INTEGER NOT NULL,
  PRIMARY KEY(user_id, week) ON CONFLICT REPLACE
);`).run();


/**
 * Turnip Prophet
 */
function turnipProphetLink(prices, pattern) {
  return 'https://turnipprophet.io/?prices=' +
    prices.slice(1).join('.').replace('undefined', '') +
    '&pattern=' + pattern;
}

/**
 * Handle all response types, so the command functions don't need to know about the Discord API.
 */
function respond(msg, results) {
  if (results['react']) {
    msg.react(results['react']);
  }

  if (results['reply']) {
    msg.reply(results['reply']);
  }

  if (results['send']) {
    msg.channel.send(results['send']);
  }
}

/**
 * Command Functions
 */
// args: PRICE
function sellPrice(user, args) {
  // Validate price.
  const price = parseInt(args[0]);
  if (!price || price < 90 || price > 110) {
    return {
      'reply': 'no'
    };
  }

  // Store the price in the DB.
  const stmt = db.prepare('INSERT INTO sell_price VALUES (?, ?, ?)');
  stmt.run(user, moment().week(), price)

  return {
    'react': '🔔'
  };
}

// args: PRICE [morning|night [DAY_OF_WEEK]]
function buyPrice(user, args) {
  // Validate price.
  const price = parseInt(args[0]);
  if (!price || price < 1 || price > 660) {
    return {
      'reply': 'no'
    };
  }

  // Validate morning|night.
  var night = moment().hour() >= 12 ? 1 : 0;
  if (args[1]) {
    const timeOfDay = args[1].toLowerCase();
    if (timeOfDay === 'morning') {
      night = 0;
    } else if (timeOfDay === 'night') {
      night = 1;
    } else {
      return {
        'reply': `${args[1]} isn't \`morning\` or \`night\``
      }
    }
  }

  // Validate day of week.
  var day = moment().day();
  var week = moment().week();
  if (args[2]) {
    const dayOfWeek = moment(args[2].toLowerCase(), ['ddd', 'dddd']).day();
    if (!dayOfWeek) {
      return {
        'reply': `${args[2]} isn't a day`
      };
    }
    if (dayOfWeek > day) {
      // Note: breaks on year rollover, but who cares.
      week--;
    }
  }
  
  // Store the price in the DB.
  const stmt = db.prepare('INSERT INTO buy_price VALUES (?, ?, ?, ?, ?)');
  stmt.run(user, week, day, night, price)

  return {
    'react': '🔔'
  };
}

// args: largespike|smallspike|fluctuating|decreasing
function lastPattern(user, args) {
  const patterns = {
    'fluctuating': 0,
    'largespike': 1,
    'decreasing': 2,
    'smallspike': 3,
  };

  if (!args[0] || !Object.keys(patterns).includes(args[0].toLowerCase())) {
    return {
      'reply': `pick your last week's pattern from: ${patterns.join(' ')}`
    };
  }

  const pattern = patterns[args[0].toLowerCase()];

  // Store the pattern in the DB.
  const stmt = db.prepare('INSERT INTO pattern VALUES (?, ?, ?)');
  // Note: breaks on year rollover, but who cares.
  stmt.run(user, moment().week()-1, pattern);

  return {
    'react': args[0].toLowerCase() === 'decreasing' ? '📉' : '📈'
  };
}

// args: [@mention]
function predict(user, args, mentions) {
  var user_id = user;
  if (mentions && mentions.first()) {
    user_id = mentions.first().id;
  }

  // Get data from the DB.
  const week = moment().week();
  const patternRow = db.prepare('SELECT pattern FROM pattern WHERE user_id = ? AND week = ?').get(user_id, week - 1);
  const sellPriceRow = db.prepare('SELECT price FROM sell_price WHERE user_id = ? AND week = ?').get(user_id, week);
  const buyPriceRows = db.prepare('SELECT day, night, price FROM buy_price WHERE user_id = ? AND week = ?').all(user_id, week);

  if (!sellPriceRow && !buyPriceRows.length) {
    return {
      'send': 'no data yet this week. try !sell, !buy, !lastpattern'
    };
  }

  // Unpack db row objeccts and convert to epected formats.
  const pattern = patternRow ? patternRow.pattern : undefined;
  const sellPrice = sellPriceRow ? sellPriceRow.price : undefined;
  var buyPriceList = Array(6 * 2);
  buyPriceRows.forEach(row => { 
    buyPriceList[row.day * 2 - 2 + row.night] = row.price;
  });
  const prices = [sellPrice, sellPrice, ...buyPriceList]

  // Predict!
  const predictor = new predictions.Predictor(prices, false, pattern);
  const generatedPossibilities = predictor.analyze_possibilities();

  const getPatternPercent = (poss, id) => {
    const filtered = poss.filter(x=>x.pattern_number===id);
    if (filtered.length) {
      return (filtered[0].category_total_probability*100).toPrecision(3) + '%';
    } else {
      return '0%';
    }
  };

  const indexToDayTime = [
    false,
    false,
    'Monday morning',
    'Monday night',
    'Tuesday morning',
    'Tuesday night',
    'Wednesday morning',
    'Wednesday night',
    'Thursday morning',
    'Thursday night',
    'Friday morning',
    'Friday night',
    'Saturday morning',
    'Saturday night',
  ];

  const getPatternPeak = (poss, id) => {
    const filtered = poss.filter(x=>x.pattern_number===id);
    if (filtered.length == 1) {
      return ' (potential peak **' +
        filtered[0].prices.flatMap((x, i) => x.max === filtered[0].weekMax ? i : []).map(x => indexToDayTime[x]) +
        '** at **' + filtered[0].weekMax + '**🔔)';
    } else {
      return '';
    }
  };

  const patternWeights = [
    ['Fluctuating', getPatternPercent(generatedPossibilities, 0), getPatternPeak(generatedPossibilities, 0)],
    ['Large Spike', getPatternPercent(generatedPossibilities, 1), getPatternPeak(generatedPossibilities, 1)],
    ['Decreasing', getPatternPercent(generatedPossibilities, 2), ''],
    ['Small Spike', getPatternPercent(generatedPossibilities, 3), getPatternPeak(generatedPossibilities, 3)],
  ]

  const reply = patternWeights.sort((x,y)=>parseInt(y[1])-parseInt(x[1])).map(x=>x.slice(0, 2).join(': ')+x[2]).join('\n') +
    '\nGuaranteed min: ' + Math.min(...generatedPossibilities.map(x=>x.weekGuaranteedMinimum)) +
    '\nPotential max: ' + Math.max(...generatedPossibilities.map(x=>x.weekMax)) +
    '\nTurnip Prophet: ' + turnipProphetLink(prices, pattern);

  return {
    'send': reply
  };
}

/**
 * Command Map
 */
commands = {
  'sell': sellPrice,
  'buy': buyPrice,
  'lastpattern': lastPattern,
  'predict': predict,
}

/**
 * Bot Main
 */
client.on('ready', () => {
  client.user.setPresence({ activity: { name: 'the stalk market' }, status: 'invisible' })
  console.log(`Logged in as ${client.user.tag}!`);
});

client.on('message', msg => {
  if (msg.content.startsWith('!')) {
    const command = commands[msg.content.slice(1).split(' ')[0]];
    if (command) {
      try {
        respond(msg, command(msg.author.id, msg.content.split(' ').slice(1), msg.mentions.users));
      } catch (e) {
        msg.reply(e.message);
        console.error(e);
      }
    } else {
      msg.reply('WHAT');
    }
  }
});

client.login(CONFIG.key);
