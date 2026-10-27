// User agents: browser + version, OS + version, device type and a bot flag (isbot's list plus ours). Rule-based (no dependency);
// the SDK adds what a user agent can't say (touch points for iPads that claim to be Macs, navigator.webdriver).

export type Agent = { browser: string; browserVersion: string; os: string; osVersion: string; device: 'desktop' | 'phone' | 'tablet'; bot: boolean };

import { ISBOT_PATTERNS } from './isbot-patterns.ts';

/** isbot's maintained list (a few hundred crawlers, previewers, monitors and libraries), and ours on top. */
const ISBOT = new RegExp(ISBOT_PATTERNS.join('|'), 'i');
const BOT = /bot\b|bot\/|crawl|spider|slurp|mediapartners|facebookexternalhit|embedly|quora link|whatsapp|telegrambot|discordbot|slackbot|twitterbot|linkedinbot|preview|lighthouse|pagespeed|pingdom|uptime|monitor|gtmetrix|headless|phantomjs|puppeteer|playwright|selenium|curl\/|wget\/|python-requests|python-urllib|aiohttp|httpclient|okhttp|go-http-client|node-fetch|undici|axios|java\//i;

const major = (v = '') => v.split('.').slice(0, 2).join('.').replace(/\.0$/, '');

export function parseUA(ua: string): Agent {
  const s = String(ua ?? '').slice(0, 512);
  let browser = 'Other';
  let browserVersion = '';
  const pick = (re: RegExp, name: string) => {
    const m = re.exec(s);
    if (!m) return false;
    browser = name;
    browserVersion = major(m[1]);
    return true;
  };
  pick(/Edg(?:e|A|iOS)?\/([\d.]+)/, 'Edge')
    || pick(/OPR\/([\d.]+)/, 'Opera')
    || pick(/SamsungBrowser\/([\d.]+)/, 'Samsung Internet')
    || pick(/YaBrowser\/([\d.]+)/, 'Yandex')
    || pick(/(?:Firefox|FxiOS)\/([\d.]+)/, 'Firefox')
    || pick(/CriOS\/([\d.]+)/, 'Chrome')
    || pick(/HeadlessChrome\/([\d.]+)/, 'Headless Chrome')
    || pick(/Chrome\/([\d.]+)/, 'Chrome')
    || pick(/Version\/([\d.]+).*Safari\//, 'Safari')
    || pick(/(?:MSIE |Trident\/.*rv:)([\d.]+)/, 'Internet Explorer')
    || (/AppleWebKit/.test(s) && /(iPhone|iPad)/.test(s) && pick(/OS ([\d_]+)/, 'Safari (in-app)'));
  browserVersion = browserVersion.replace(/_/g, '.');

  let os = 'Other';
  let osVersion = '';
  let m: RegExpExecArray | null;
  if ((m = /Windows NT ([\d.]+)/.exec(s))) {
    os = 'Windows';
    osVersion = ({ '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7' } as Record<string, string>)[m[1]] ?? m[1];
  } else if ((m = /iPad.*?OS ([\d_]+)/.exec(s))) {
    os = 'iPadOS';
    osVersion = major(m[1].replace(/_/g, '.'));
  } else if ((m = /(?:iPhone|iPod).*?OS ([\d_]+)/.exec(s))) {
    os = 'iOS';
    osVersion = major(m[1].replace(/_/g, '.'));
  } else if ((m = /Android ([\d.]+)/.exec(s)) || /Android/.test(s)) {
    os = 'Android';
    osVersion = m ? major(m[1]) : '';
  } else if (/CrOS/.test(s)) {
    os = 'ChromeOS';
  } else if ((m = /Mac OS X ([\d_.]+)/.exec(s))) {
    os = 'macOS';
    osVersion = major(m[1].replace(/_/g, '.'));
  } else if (/Linux/.test(s)) {
    os = 'Linux';
  }

  let device: Agent['device'] = 'desktop';
  if (/iPad|Tablet|PlayBook|Silk|Kindle/.test(s) || (os === 'Android' && !/Mobile/.test(s))) device = 'tablet';
  else if (/Mobi|iPhone|iPod|Android|Windows Phone/.test(s)) device = 'phone';

  return { browser, browserVersion, os, osVersion, device, bot: !s || BOT.test(s) || ISBOT.test(s) };
}
