import puppeteer from 'puppeteer';

import { terminal } from 'terminal-kit';

import { PNG } from 'pngjs';

import pixelmatch from 'pixelmatch';

import { stepsToString, roundTime, path, wait } from './utils.js';

import { pathExists, ensureDir, readFile, writeFile } from 'fs-extra';

import { exitForcefully } from '.';

const stepTimeout = 10000;

/**
* @param { import('./map.js').MightMap } map
* @param { import('.').MightConfig } config
*/
export async function runner(map, config)
{
  // eslint-disable-next-line no-async-promise-executor
  await new Promise(async(resolve) =>
  {
    const tasks = map.map((t) => t.title || stepsToString(t.steps));

    terminal.clear();

    terminal('[Might] Running Tests:');

    // map has no tests
    if (tasks.length <= 0)
    {
      terminal.yellow('\n\nMap has no tests.');
      
      return resolve();
    }

    // show a progress ba in the terminal
    const progressBar = terminal.progressBar({
      width: 80,
      title: '\n\n',
      percent: true,
      items: tasks.length
    });

    // ensure the screenshots directory exists
    await ensureDir(path('__might__'));

    // launch puppeteer
    const browser = await puppeteer.launch({
      timeout: stepTimeout,
      defaultViewport: { width: 1366, height: 768 },
      args: [ '--no-sandbox', '--disable-setuid-sandbox' ]
    });

    // run all test in sequence
    for (const t of map)
    {
      const title = t.title || stepsToString(t.steps);

      let selector;

      try
      {
        progressBar.startItem(title);

        t.startTimeStamp = Date.now();
      
        const page = await browser.newPage();

        // an attempt to make tests more consistent
        // through different machines
        await page.setExtraHTTPHeaders({
          'X-Forwarded-For': '8.8.8.8',
          'Accept-Language': 'en-US,en;q=0.5'
        });

        // go to the web app's url
        await page.goto(config.url, {
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
        if (!screenshotExists || config.update)
        {
          await page.screenshot({
            path: screenshotLocation
          });

          t.state = 'updated';
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

          t.state = 'passed';
        }

        t.endTimeStamp = Date.now();

        progressBar.itemDone(title);
      }
      catch (e)
      {
        // test failed
        t.error = e;
        t.state = 'failed';
        t.endTimeStamp = Date.now();
        
        // one test failed
        // don't run the rest
        break;
      }
    }

    // clear terminal
    progressBar.stop();
    terminal.clear();

    // close puppeteer
    await browser.close();

    // print info about all tests

    terminal('[Might] Tests Results:\n\n');

    for (const t of map)
    {
      const title = t.title || stepsToString(t.steps);

      const time = roundTime(t.startTimeStamp, t.endTimeStamp);

      if (t.state === 'passed')
      {
        terminal.green(`PASSED (${time}s) `);
        terminal(`${title}\n`);
      }
      else if (t.state === 'updated')
      {
        terminal.yellow(`UPDATED (${time}s) `);
        terminal(`${title}\n\n`);
      }
      else
      {
        terminal.red(`FAILED (${time}s) `);
        terminal(`${title}\n\n`);

        // print the error
        terminal(t.error);

        if (t.errorPath)
          terminal(`\n\n${t.errorPath}`);

        // force exit the process with an exit code 1
        exitForcefully();

        break;
      }
    }

    resolve();
  });
}