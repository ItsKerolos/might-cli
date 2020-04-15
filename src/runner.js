import puppeteer from 'puppeteer';

import { PNG } from 'pngjs';

import pixelmatch from 'pixelmatch';

// TODO eliminate use of path() inside of the api

import { stepsToString, path, wait } from './utils.js';

import { pathExists, ensureDir, readFile, writeFile } from 'fs-extra';

// TODO add map type

/**
*
* @param { {
  url: string,
  map: any,
  update: boolean,
  target: string[],
  stepTimeout: number
 } } options
* @param { (type: 'progress' | 'error' | 'done', value: any) => void } callback
*/
export async function runner(options, callback)
{
  options = options || {};

  options.stepTimeout = options.stepTimeout || 15000;

  let map = options.map;

  if (!map)
  {
    callback('error', {
      message: 'Error: Unable to load map file'
    });

    return;
  }
  
  const skipped = [];

  let passed = 0;
  let updated = 0;
  let failed = 0;

  // TODO research allowing people to use might with jest
  // maybe make runner use functions like screenshot, compare doStep() ?
  
  // filter tests using maps and target
  if (Array.isArray(options.target))
  {
    map = map.filter((t) =>
    {
      // leave the test in map
      // if its a target
      if (options.target.includes(t.title))
        return true;
      // remove test from map
      // push it to a different array
      // to allow us to output skipped tests to terminal
      else
        skipped.push(t);
    });
  }

  const tasks = map.map((t) => t.title || stepsToString(t.steps));

  // if map has no tests or if all tests were skipped
  if (tasks.length <= 0)
  {
    callback('done', {
      total: map.length + skipped.length,
      skipped: skipped.length
    });

    return;
  }

  // ensure the screenshots directory exists
  await ensureDir(path('__might__'));

  // launch puppeteer
  const browser = await puppeteer.launch({
    timeout: options.stepTimeout,
    defaultViewport: { width: 1366, height: 768 },
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ]
  });

  // run tests in sequence
  for (const t of map)
  {
    const title = t.title || stepsToString(t.steps);

    let selector;

    try
    {
      callback('progress', {
        title,
        state: 'running'
      });
  
      t.startTimeStamp = Date.now();
      
      const page = await browser.newPage();

      // an attempt to make tests more consistent
      // through different machines
      await page.setExtraHTTPHeaders({
        'X-Forwarded-For': '8.8.8.8',
        'Accept-Language': 'en-US,en;q=0.5'
      });

      // go to the web app's url
      await page.goto(options.url, {
      // septate timeout - since some web app will take some time
      // to compile, start then load
        timeout: 60000
      });
  
      // follow test steps
      for (const s of t.steps)
      {
        if (s.action === 'wait')
        {
          await wait(s.value);
        }
        else if  (s.action === 'select')
        {
          selector = s.value;
        }
        else if (s.action === 'click')
        {
          await page.click(selector);
        }
        else if (s.action === 'type')
        {
          await page.type(selector, s.value);
        }
      }
  
      // all steps were executed
  
      const screenshotLocation = path(`__might__/${stepsToString(t.steps, '_').split(' ').join('_').toLowerCase()}.png`);
  
      const screenshotExists = await pathExists(screenshotLocation);
  
      // update the stored screenshot
      if (!screenshotExists || options.update)
      {
        await page.screenshot({
          path: screenshotLocation
        });
  
        callback('progress', {
          title,
          state: 'updated',
          time: Date.now() - t.startTimeStamp
        });

        updated = updated + 1;
      }
      else
      {
        const img1 = PNG.sync.read(await page.screenshot({}));
        const img2 = PNG.sync.read(await readFile(screenshotLocation));
  
        const diff = new PNG({ width: img1.width, height: img1.height });
  
        const mismatch = pixelmatch(img1.data, img2.data, diff.data, img1.width, img1.height);
  
        if (mismatch > 0)
        {
          const diffLocation = path(`might.error.${new Date().toISOString()}.png`);
  
          await writeFile(diffLocation, PNG.sync.write(diff));
  
          t.errorPath = diffLocation;
  
          throw new Error(`Mismatched ${mismatch} pixels`);
        }
  
        callback('progress', {
          title,
          state: 'passed',
          time: Date.now() - t.startTimeStamp
        });

        passed = passed + 1;
      }
    }
    catch (e)
    {
      // test failed
      callback('error', {
        title,
        error: e,
        time: Date.now() - t.startTimeStamp
      });

      failed = failed + 1;

      // if one test failed then don't run the rest
      break;
    }
  }

  // close puppeteer
  await browser.close();

  callback('done', {
    total: map.length + skipped.length,
    passed,
    updated,
    skipped: skipped.length,
    failed
  });
}