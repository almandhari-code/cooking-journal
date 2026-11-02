const {test,expect}=require('@playwright/test');
const {makePdf,RECEIPT}=require('./helpers/pdf');
const clean=page=>page.addInitScript(()=>{if(!sessionStorage.seeded){localStorage.clear();sessionStorage.seeded=1;localStorage.setItem('groq_api_key','gsk_test')}});
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');

/** Mock the AI service; `reply` is what the receipt call returns. Records requests. */
async function mock(page,log,reply){
  await page.route('**/chat/completions',r=>{
    const b=r.request().postDataJSON();log.push(b);
    r.fulfill({json:{choices:[{message:{content:JSON.stringify(typeof reply==='function'?reply(b):reply)}}]}});
  });
}
const AI={items:[
  {name:'red onion',amount:'1.2',unit:'kg',unsure:false},{name:'onions',amount:'1',unit:'kg',unsure:false}, // duplicate of the first
  {name:'milk',amount:'1',unit:'l',unsure:false},{name:'chicken breast',amount:'2',unit:'',unsure:false},
  {name:'plastic bag',amount:'',unit:'',unsure:false},{name:'VAT 5%',amount:'',unit:'',unsure:false}, // not food
  {name:'zxq paste',amount:'',unit:'',unsure:true}]};
const pdfFile=(lines)=>({name:'receipt.pdf',mimeType:'application/pdf',buffer:makePdf(lines)});

test('text PDF: extracted in browser, non-food dropped, deduped, unsure unchecked, nothing auto-added',async({page})=>{
  const log=[];await clean(page);await mock(page,log,AI);await page.goto('/#/pantry');
  await page.setInputFiles('#rc-file',pdfFile(RECEIPT));
  await page.click('#rc-ok'); // first-time privacy notice
  const rows=page.locator('.rclist li');
  await expect(rows).toHaveCount(4); // red onion, milk, chicken breast, zxq paste
  await expect(page.locator('.rclist')).not.toContainText('bag');
  await expect(page.locator('.rclist')).not.toContainText('VAT');
  await expect(rows.filter({hasText:'zxq paste'}).locator('input')).not.toBeChecked();
  await expect(rows.filter({hasText:'milk'}).locator('input')).toBeChecked();
  await expect(page.locator('.pchip')).toHaveCount(0); // nothing added yet
  // the text layer (not an image) went to the AI, with the receipt lines
  expect(log[0].messages[1].content).toContain('ONIONS RED 1.2 KG');
  expect(JSON.stringify(log[0])).not.toContain('image_url');
  await page.click('#rc-add');
  await expect(page.locator('.pchip')).toHaveCount(3);
  await expect(page.locator('#chips')).not.toContainText('zxq');
  await expect(page.locator('#rc-done')).toContainText('Added 3');
});

test('merge: items already in the pantry (onion/onions) are not duplicated',async({page})=>{
  await clean(page);await mock(page,[],{items:[{name:'onion',amount:'2',unit:''},{name:'rice',amount:'',unit:''}]});
  await page.goto('/#/pantry');
  await page.fill('#pitem','onions');await page.press('#pitem','Enter');
  await page.setInputFiles('#rc-file',pdfFile(RECEIPT));await page.click('#rc-ok');
  await expect(page.locator('.rclist li').filter({hasText:'onion'})).toContainText('already in your pantry');
  await expect(page.locator('.rclist li').filter({hasText:'onion'}).locator('input')).toBeDisabled();
  await page.click('#rc-add');
  await expect(page.locator('.pchip')).toHaveCount(2); // onions + rice
});

test('XSS in a receipt line renders as text',async({page})=>{
  let fired=false;page.on('dialog',d=>{fired=true;d.dismiss()});
  await clean(page);await mock(page,[],{items:[{name:'<img src=x onerror=alert(1)> tomatoes'},{name:'<script>alert(2)</script>garlic'}]});
  await page.goto('/#/pantry');
  await page.setInputFiles('#rc-file',pdfFile(RECEIPT));await page.click('#rc-ok');
  await expect(page.locator('.rclist')).toContainText('<img src=x onerror=alert(1)> tomatoes');
  await expect(page.locator('.rclist img')).toHaveCount(0);
  await page.click('#rc-add');
  await expect(page.locator('#chips')).toContainText('<script>alert(2)</script>garlic');
  expect(fired).toBe(false);
});

test('scanned PDF (no text layer): pages are rendered and sent to the vision model',async({page})=>{
  const log=[];await clean(page);await mock(page,log,{items:[{name:'rice'}]});
  await page.addInitScript(()=>localStorage.setItem('cj_receipt_notice_seen','1'));
  await page.goto('/#/pantry');
  await page.setInputFiles('#rc-file',pdfFile([]));
  await expect(page.locator('.rclist li')).toHaveCount(1);
  const b=log[0];
  expect(b.model).toBe('qwen/qwen3.8-27b');
  const img=b.messages[1].content.find(c=>c.type==='image_url').image_url.url;
  expect(img).toMatch(/^data:image\/jpeg;base64,/);
  expect(img.length*.75).toBeLessThan(4*1024*1024);
});

test('photo: re-encoded to JPEG (no EXIF) and sent; privacy notice comes first and can be cancelled',async({page})=>{
  const log=[];await clean(page);await mock(page,log,{items:[{name:'rice'}]});await page.goto('/#/pantry');
  await page.setInputFiles('#rc-file',{name:'r.png',mimeType:'image/png',buffer:PNG});
  await expect(page.locator('#rc-ok')).toBeVisible();
  await page.click('#rc-no');expect(log.length).toBe(0); // nothing uploaded before consent
  await page.setInputFiles('#rc-file',{name:'r.png',mimeType:'image/png',buffer:PNG});
  await page.click('#rc-ok');
  await expect(page.locator('.rclist li')).toHaveCount(1);
  expect(log[0].messages[1].content.find(c=>c.type==='image_url').image_url.url).toMatch(/^data:image\/jpeg/);
  // notice is one-time
  await page.setInputFiles('#rc-file',{name:'r.png',mimeType:'image/png',buffer:PNG});
  await expect(page.locator('.rclist li')).toHaveCount(1);
  expect(log.length).toBe(2);
});

test('no food found: clear message, never a silent empty list',async({page})=>{
  await clean(page);await mock(page,[],{items:[{name:'plastic bag'},{name:'total'}]});
  await page.addInitScript(()=>localStorage.setItem('cj_receipt_notice_seen','1'));
  await page.goto('/#/pantry');
  await page.setInputFiles('#rc-file',pdfFile(RECEIPT));
  await expect(page.locator('.rc')).toContainText('No food items found');
});

test('unreadable file gives an error, no key gives the key message',async({page})=>{
  await clean(page);await mock(page,[],{items:[]});
  await page.addInitScript(()=>localStorage.setItem('cj_receipt_notice_seen','1'));
  await page.goto('/#/pantry');
  await page.setInputFiles('#rc-file',{name:'bad.png',mimeType:'image/png',buffer:Buffer.from('not an image')});
  await expect(page.locator('#error')).toContainText('Could not open');
  await page.evaluate(()=>localStorage.removeItem('groq_api_key'));
  await page.setInputFiles('#rc-file',pdfFile(RECEIPT));
  await expect(page.locator('#error')).toContainText('AI key');
});

test('vision model gone (404 / model_decommissioned): friendly message',async({page})=>{
  await clean(page);
  await page.addInitScript(()=>localStorage.setItem('cj_receipt_notice_seen','1'));
  await page.route('**/chat/completions',r=>r.fulfill({status:400,json:{error:{message:'model_decommissioned',code:'model_decommissioned'}}}));
  await page.goto('/#/pantry');
  await page.setInputFiles('#rc-file',{name:'r.png',mimeType:'image/png',buffer:PNG});
  await expect(page.locator('#error')).toContainText('AI photo reader is unavailable');
  await page.route('**/chat/completions',r=>r.fulfill({status:404,json:{error:{message:'nope'}}}));
  await page.setInputFiles('#rc-file',{name:'r.png',mimeType:'image/png',buffer:PNG});
  await expect(page.locator('#error')).toContainText('please try the PDF or type items');
});

test('<think> blocks are stripped before parsing',async({page})=>{
  await clean(page);
  await page.addInitScript(()=>localStorage.setItem('cj_receipt_notice_seen','1'));
  await page.route('**/chat/completions',r=>r.fulfill({json:{choices:[{message:{content:'<think>hmm {"items":[]}</think>{"items":[{"name":"rice"}]}'}}]}}));
  await page.goto('/#/pantry');
  await page.setInputFiles('#rc-file',{name:'r.png',mimeType:'image/png',buffer:PNG});
  await expect(page.locator('.rclist li')).toHaveCount(1);
});

test('file over 25 MB is refused with a message',async({page})=>{
  await clean(page);await mock(page,[],{items:[]});
  await page.addInitScript(()=>localStorage.setItem('cj_receipt_notice_seen','1'));
  await page.goto('/#/pantry');
  await page.setInputFiles('#rc-file',{name:'big.pdf',mimeType:'application/pdf',buffer:Buffer.alloc(30*1024*1024)});
  await expect(page.locator('#error')).toContainText('over 25 MB');
});

test('NOT_FOOD matches whole non-food lines, not words inside item names',async({page})=>{
  await clean(page);
  await page.addInitScript(()=>localStorage.setItem('cj_receipt_notice_seen','1'));
  await page.goto('/');
  const kept=await page.evaluate(async()=>{
    const {parseReceipt}=await import('/js/receipt.js');
    return parseReceipt({items:['chicken store pack','VAT 5%','Total','Change','Carrier bag','Order No. 123','Service charge','Store name','orange','Tax'].map(name=>({name}))}).map(r=>r.name);
  });
  expect(kept).toEqual(['chicken store pack','orange']);
});
