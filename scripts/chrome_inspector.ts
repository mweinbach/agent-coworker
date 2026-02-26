import puppeteer from 'puppeteer-core';

async function main() {
  const browserURL = 'http://127.0.0.1:9222';
  try {
    const browser = await puppeteer.connect({ browserURL });
    const pages = await browser.pages();
    
    // Find the main electron window or first page
    for (const page of pages) {
      const title = await page.title();
      const url = page.url();
      console.log(`Page: ${title} (${url})`);
      
      // Attempt to get the error that happened by just asking if there are console errors stored or something, 
      // but since we're attaching late, we might not get past console errors.
      // But we can check local storage, state, or DOM elements.
      if (url.includes('1420') || url.includes('file://')) {
        const errorText = await page.evaluate(() => {
          return document.body.innerText.includes('ERROR') ? 'ERROR on screen' : 'No ERROR text found';
        });
        console.log(`- UI state check: ${errorText}`);
        
        // Also capture window errors or react errors if they are in some global
        const logs = await page.evaluate(() => {
          return window.localStorage.getItem('cowork-state') || 'No state';
        });
      }
    }
    
    await browser.disconnect();
  } catch (err) {
    console.error('Error connecting to Chrome DevTools:', err);
  }
}

main();