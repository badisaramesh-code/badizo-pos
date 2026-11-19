import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import PaymentDiaryView, {DiaryPaymentDialog,PaymentDiaryReminder,groupDiaryBills} from './PaymentDiaryView';
import api from '../api/client';
import * as XLSX from 'xlsx';
jest.mock('xlsx',()=>({...jest.requireActual('xlsx'),writeFile:jest.fn()}));
jest.mock('../api/client',()=>({__esModule:true,default:{get:jest.fn(),post:jest.fn(),put:jest.fn(),delete:jest.fn()}}));
let mockDay='2026-11-11';
jest.mock('../utils/date',()=>({todayIso:()=>mockDay}));
let container,root;
const due={id:1,account_scope:'LOCAL',account_name:'SUPPLIER',bill_no:'INV-1',bill_date:'2026-10-01',due_date:'2026-11-11',amount:100,paid_amount:0,discount_amount:0,pending_amount:100,status:'PENDING'};
const view=()=>({rows:[due],summary:{pending:100,due:100},year:2026,active_year:2026,earliest_year:2025,closed_years:[],today:mockDay,as_of:mockDay});
const button=text=>[...container.querySelectorAll('button')].find(el=>el.textContent===text);
const input=label=>[...container.querySelectorAll('label')].find(el=>el.textContent.startsWith(label))?.querySelector('input,select');
beforeEach(()=>{global.IS_REACT_ACT_ENVIRONMENT=true;jest.useFakeTimers();mockDay='2026-11-11';sessionStorage.clear();api.get.mockReset().mockImplementation(()=>Promise.resolve({data:view()}));for(const method of ['post','put','delete'])api[method].mockReset().mockResolvedValue({data:{id:1}});container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();jest.useRealTimers();delete global.IS_REACT_ACT_ENVIRONMENT;});

test('payment stores bank, paid amount and discount with one request identity across an uncertain retry',async()=>{
  api.post.mockRejectedValueOnce(new Error('Connection interrupted')).mockResolvedValueOnce({data:{id:1}});
  const saved=jest.fn();await act(async()=>root.render(<DiaryPaymentDialog row={due} onClose={()=>{}} onSaved={saved}/>));
  await act(async()=>{Simulate.change(input('Paid amount'),{target:{value:'95'}});Simulate.change(input('Less / Discount'),{target:{value:'5'}});Simulate.change(input('Payment through'),{target:{value:'Bank'}});});
  await act(async()=>Simulate.change(input('Bank / account name'),{target:{value:'HDFC'}}));
  await act(async()=>Simulate.submit(container.querySelector('form'),{preventDefault:()=>{}}));
  expect(saved).not.toHaveBeenCalled();expect(container.textContent).toContain('Connection interrupted');
  await act(async()=>Simulate.submit(container.querySelector('form'),{preventDefault:()=>{}}));
  const first=api.post.mock.calls[0],second=api.post.mock.calls[1];
  expect(first[0]).toBe('/local-payment-diary/1/payments');expect(first[1]).toMatchObject({paid_amount:'95',discount_amount:'5',payment_mode:'Bank',bank_name:'HDFC'});
  expect(second[1].request_id).toBe(first[1].request_id);expect(saved).toHaveBeenCalledTimes(1);
});
test('overpayment plus discount cannot be confirmed',async()=>{
  await act(async()=>root.render(<DiaryPaymentDialog row={due} onClose={()=>{}} onSaved={()=>{}}/>));
  await act(async()=>Simulate.change(input('Less / Discount'),{target:{value:'1'}}));
  expect(button('Confirm payment & post to ledger').disabled).toBe(true);expect(api.post).not.toHaveBeenCalled();
});
test('counter login never requests or shows the financial reminder',async()=>{
  await act(async()=>root.render(<PaymentDiaryReminder user={{username:'counter1',role:'COUNTER'}}/>));
  expect(api.get).not.toHaveBeenCalled();expect(container.querySelector('[role="dialog"]')).toBeNull();
});
test('today and overdue unpaid reminders preserve minimize restore and daily dismissal',async()=>{
 api.get.mockResolvedValue({data:{...view(),rows:[due,{...due,id:2,account_name:'OLD',due_date:'2026-11-10'},{...due,id:3,account_name:'FUTURE',due_date:'2026-11-12'}]}});
 await act(async()=>root.render(<PaymentDiaryReminder user={{username:'admin',role:'ADMIN'}}/>));
 expect(container.textContent).toContain('SUPPLIER');expect(container.textContent).toContain('OLD');expect(container.textContent).not.toContain('FUTURE');
 await act(async()=>Simulate.click(container.querySelector('[aria-label="Minimize payment reminder"]')));await act(async()=>jest.advanceTimersByTime(60000));expect(container.querySelector('[role="dialog"]')).toBeNull();
 await act(async()=>Simulate.click(button("Today's payments (2) · Restore")));expect(container.querySelector('[role="dialog"]')).toBeTruthy();
 await act(async()=>Simulate.click(button('Close for today')));expect(api.post).not.toHaveBeenCalled();
 mockDay='2026-11-12';api.get.mockResolvedValue({data:{...view(),rows:[{...due,account_name:'FUTURE',due_date:mockDay}]}});await act(async()=>jest.advanceTimersByTime(60000));expect(container.textContent).toContain('FUTURE');expect(container.textContent).not.toContain('SUPPLIER');
});

test('name suggestions require three letters and search only the chosen Local/Non-Local scope',async()=>{
  api.get.mockImplementation((url)=>Promise.resolve({data:url.endsWith('/accounts')?[{account_name:'SUPPLIER'}]:view()}));
  await act(async()=>root.render(<PaymentDiaryView/>));await act(async()=>Simulate.click(button('Today\'s dues / overdue')));
  await act(async()=>Simulate.change(input('Account name'),{target:{value:'SU'}}));await act(async()=>jest.advanceTimersByTime(250));
  expect(api.get.mock.calls.filter(([url])=>url.endsWith('/accounts'))).toHaveLength(0);
  await act(async()=>Simulate.change(input('Account name'),{target:{value:'SUP'}}));await act(async()=>jest.advanceTimersByTime(250));
  const lookup=api.get.mock.calls.find(([url])=>url.endsWith('/accounts'));
  expect(lookup[1].params).toEqual({scope:'LOCAL',search:'SUP'});expect(button('SUPPLIER')).toBeTruthy();
  await act(async()=>Simulate.change(input('Account type'),{target:{value:'NON_LOCAL'}}));
  expect(input('Account name').value).toBe('');
});
test('past FY hides new reminder and payment actions while retaining history and closing controls',async()=>{
  await act(async()=>root.render(<PaymentDiaryView/>));await act(async()=>Simulate.click(button('Today\'s dues / overdue')));
  await act(async()=>Simulate.change(input('Financial year'),{target:{value:'2025'}}));await act(async()=>jest.advanceTimersByTime(250));
  expect(button('Add reminder')).toBeUndefined();expect(button('Record payment')).toBeUndefined();
  expect(button('History')).toBeTruthy();expect(button('Close this completed year')).toBeTruthy();
});

test('invoice number is optional and an uncertain reminder retry keeps its automatic reference',async()=>{
  api.post.mockRejectedValueOnce(new Error('Network interruption')).mockResolvedValueOnce({data:{id:2}});
  await act(async()=>root.render(<PaymentDiaryView/>));await act(async()=>Simulate.click(button('Today\'s dues / overdue')));
  expect(input('Bill / invoice number').required).toBe(false);
  await act(async()=>{Simulate.change(input('Account name'),{target:{value:'SUPPLIER'}});Simulate.change(input('Bill amount'),{target:{value:'100'}});});
  await act(async()=>Simulate.submit(container.querySelector('form'),{preventDefault:()=>{}}));
  await act(async()=>Simulate.submit(container.querySelector('form'),{preventDefault:()=>{}}));
  expect(api.post).toHaveBeenCalledTimes(2);
  const first=api.post.mock.calls[0][1],second=api.post.mock.calls[1][1];
  expect(first.bill_no).toMatch(/^REM-/);expect(second.bill_no).toBe(first.bill_no);
  expect(second.request_id).toBe(first.request_id);expect(input('Bill / invoice number').value).toBe('');
});
test('existing unpaid reminder edits include a reason and version without posting another payment',async()=>{
  await act(async()=>root.render(<PaymentDiaryView/>));await act(async()=>Simulate.click(button('Today\'s dues / overdue')));
  await act(async()=>Simulate.click(button('Edit')));
  await act(async()=>{Simulate.change(input('Amount'),{target:{value:'150'}});Simulate.change(input('Reason'),{target:{value:'Corrected amount'}});});
  await act(async()=>Simulate.submit(container.querySelector('[aria-label="Edit reminder"] form'),{preventDefault:()=>{}}));
  expect(api.put).toHaveBeenCalledWith('/local-payment-diary/1',expect.objectContaining({amount:'150',reason:'Corrected amount',version:0}));
  expect(api.post).not.toHaveBeenCalled();
});
test('delete asks for a reason and removes only the selected reminder',async()=>{
  await act(async()=>root.render(<PaymentDiaryView/>));await act(async()=>Simulate.click(button('Today\'s dues / overdue')));
  await act(async()=>Simulate.click(button('Delete')));
  expect(container.textContent).toContain('You can restore it from Deleted reminders');
  await act(async()=>Simulate.change(input('Reason'),{target:{value:'Duplicate'}}));
  await act(async()=>Simulate.submit(container.querySelector('[aria-label="Delete reminder"] form'),{preventDefault:()=>{}}));
  expect(api.delete).toHaveBeenCalledWith('/local-payment-diary/1',expect.objectContaining({data:expect.objectContaining({reason:'Duplicate',version:0})}));
  expect(api.post).not.toHaveBeenCalled();
});
test('paid reminder cannot have its amount edited or be deleted without reversal',async()=>{
  api.get.mockResolvedValue({data:{...view(),rows:[{...due,paid_amount:40,pending_amount:60}]}});
  await act(async()=>root.render(<PaymentDiaryView/>));await act(async()=>Simulate.click(button('Today\'s dues / overdue')));
  await act(async()=>Simulate.click(button('Edit')));expect(input('Amount').disabled).toBe(true);
  await act(async()=>Simulate.click(button('Cancel')));await act(async()=>Simulate.click(button('Delete')));
  expect(button('Confirm delete')).toBeUndefined();expect(container.textContent).toContain('Reverse it in History');
});

test('dealer/day grouping sums remaining balances and keeps scopes and dates separate',()=>{
 const rows=[{...due,pending_amount:10.10,reminder_date:'2026-11-14'},{...due,id:2,bill_no:'INV-2',bill_date:'2026-10-30',pending_amount:20.20,reminder_date:'2026-11-14'},{...due,id:3,pending_amount:30.30,reminder_date:'2026-11-14'},{...due,id:4,account_scope:'NON_LOCAL',reminder_date:'2026-11-14'},{...due,id:5,reminder_date:'2026-11-15'}];
 const groups=groupDiaryBills(rows);expect(groups).toHaveLength(3);const combined=groups.find(g=>g.rows.length===3);expect(combined.pendingCents).toBe(6060);expect(combined.rows.map(r=>r.id)).toEqual([1,2,3]);
});
test('diary and reminder show a combined dealer total with separate bill details',async()=>{
 api.get.mockResolvedValue({data:{...view(),rows:[due,{...due,id:2,bill_no:'INV-2',bill_date:'2026-10-16',pending_amount:200,amount:200}]}});
 await act(async()=>root.render(<PaymentDiaryView/>));await act(async()=>Simulate.click(button('Today\'s dues / overdue')));
 expect(container.querySelector('.diary-group-heading').textContent).toContain('2 bills');expect(container.querySelector('.diary-group-heading').textContent).toContain('300.00');expect(container.textContent).toContain('INV-1');expect(container.textContent).toContain('INV-2');expect(container.textContent).toContain('2026-10-16');expect([...container.querySelectorAll('button')].filter(b=>b.textContent==='Record payment')).toHaveLength(2);
 await act(async()=>root.render(<PaymentDiaryReminder user={{username:'admin',role:'ADMIN'}}/>));
 expect(container.querySelector('.diary-group-heading').textContent).toContain('300.00');expect(container.textContent).toContain('INV-1');expect(container.textContent).toContain('INV-2');expect(container.textContent).toContain('2026-10-16');
});


test('Show requires criteria; Clear and Reset empty results and Refresh cannot repopulate them',async()=>{
 await act(async()=>root.render(<PaymentDiaryView/>));await act(async()=>jest.advanceTimersByTime(250));
 expect(api.get).not.toHaveBeenCalled();expect(container.querySelectorAll('.diary-table-panel tbody tr')).toHaveLength(0);
 await act(async()=>Simulate.click(button('Show')));expect(api.get).not.toHaveBeenCalled();expect(container.textContent).toContain('Enter an account / bill');
 await act(async()=>Simulate.change(input('Reminder from'),{target:{value:'2026-11-01'}}));
 expect(api.get).not.toHaveBeenCalled();await act(async()=>Simulate.click(button('Show')));
 expect(container.querySelector('.diary-table-panel').textContent).toContain('SUPPLIER');
 await act(async()=>Simulate.click(button('Refresh')));expect(api.get.mock.calls.at(-1)[1].params.from).toBe('2026-11-01');
 await act(async()=>Simulate.click(button('Clear')));expect(input('Reminder from').value).toBe('');expect(container.querySelector('.diary-table-panel').textContent).not.toContain('SUPPLIER');
 const count=api.get.mock.calls.length;await act(async()=>Simulate.click(button('Refresh')));await act(async()=>jest.advanceTimersByTime(250));expect(api.get.mock.calls.length).toBe(count);
 await act(async()=>Simulate.change(input('Account / bill search'),{target:{value:'SUPPLIER'}}));await act(async()=>Simulate.click(button('Show')));expect(container.querySelector('.diary-table-panel').textContent).toContain('SUPPLIER');await act(async()=>Simulate.change(input('Reminder to'),{target:{value:'2026-11-12'}}));await act(async()=>Simulate.click(button('Show')));expect(container.querySelector('.diary-table-panel').textContent).toContain('SUPPLIER');
 await act(async()=>Simulate.click(button('Reset')));expect(input('Account / bill search').value).toBe('');expect(input('Status').value).toBe('PENDING');expect(container.querySelector('.diary-table-panel').textContent).not.toContain('SUPPLIER');
});

test('previous diary opens yesterday for both scopes and shows actual dated totals',async()=>{
 const payment={id:9,diary_id:1,account_scope:'NON_LOCAL',account_name:'SUPPLIER',bill_no:'INV-1',due_date:'2026-11-07',payment_date:'2026-11-10',paid_amount:40,discount_amount:2,payment_mode:'Bank',bank_name:'HDFC',reference_no:'UTR123',notes:'Part payment',created_by:'admin'};
 api.get.mockResolvedValue({data:{...view(),rows:[due],statement:[payment],statement_summary:{from:'2026-11-10',to:'2026-11-10',count:1,paid:40,discount:2,days:[{date:'2026-11-10',count:1,paid:40,discount:2,total:42}]}}});
 await act(async()=>root.render(<PaymentDiaryView/>));await act(async()=>Simulate.click(button('Previous diary')));
 expect(api.get.mock.calls.at(-1)[1].params).toMatchObject({scope:'ALL',period:'PREVIOUS',from:'2026-11-10',to:'2026-11-10'});expect(container.textContent).toContain('10/11/2026');expect(container.textContent).toContain('UTR123');expect(container.textContent).toContain('Total paid');expect(input('Payment from').value).toBe('2026-11-10');expect(container.querySelector('.diary-entry')).toBeNull();
 await act(async()=>Simulate.click(button('Upcoming payments')));expect(api.get.mock.calls.at(-1)[1].params).toMatchObject({scope:'LOCAL',from:'2026-11-12',to:'',status:'PENDING',period:''});
});
test('payment statement Excel contains date range, daily totals and payment rows',async()=>{
 const payment={id:1,diary_id:1,account_scope:'NON_LOCAL',account_name:'SUPPLIER',bill_no:'INV',due_date:'2026-10-01',payment_date:'2026-11-10',paid_amount:10.25,discount_amount:1.75,payment_mode:'Bank',bank_name:'HDFC'};
 api.get.mockResolvedValue({data:{...view(),rows:[due],statement:[payment],statement_summary:{from:'2026-11-10',to:'2026-11-10',count:1,paid:10.25,discount:1.75,days:[{date:'2026-11-10',count:1,paid:10.25,discount:1.75,total:12}]}}});
 await act(async()=>root.render(<PaymentDiaryView/>));await act(async()=>Simulate.click(button('Previous diary')));await act(async()=>Simulate.click(button('Export Excel')));
 const [book,name]=XLSX.writeFile.mock.calls.at(-1);expect(name).toBe('payment-statement-2026-11-10-2026-11-10.xlsx');expect(book.SheetNames).toEqual(['Statement totals','Payments']);expect(XLSX.utils.sheet_to_json(book.Sheets['Statement totals'])[0]).toMatchObject({'Payment from':'10/11/2026','Total paid':10.25,'Total settled':12});expect(XLSX.utils.sheet_to_json(book.Sheets.Payments)[0]).toMatchObject({'Paid on':'10/11/2026','Account type':'NON_LOCAL','Paid amount':10.25});
});

test('reminder colors only the action buttons and retains completed shops',async()=>{
 await act(async()=>root.render(<PaymentDiaryReminder user={{username:'server',role:'SERVER'}}/>));expect(button('Record payment').className).toBe('diary-payment-pending');expect(container.querySelector('.diary-reminder-unpaid')).toBeNull();
 api.get.mockResolvedValue({data:{...view(),rows:[{...due,paid_amount:100,pending_amount:0,status:'PAID',payments:[{payment_date:mockDay}]},{...due,id:2,account_name:'PAID OVERDUE',due_date:'2026-11-01',paid_amount:100,pending_amount:0,payments:[{payment_date:mockDay}]},{...due,id:3,account_name:'OLD UNPAID',due_date:'2026-11-01'}]}});
 await act(async()=>window.dispatchEvent(new Event('badizo-local-diary-updated')));
 expect(container.textContent).toContain('SUPPLIER');expect(container.textContent).toContain('PAID OVERDUE');expect(container.textContent).toContain('OLD UNPAID');expect(container.querySelectorAll('button.diary-payment-ok')).toHaveLength(2);expect(container.querySelector('.diary-reminder-paid')).toBeNull();expect(button('✓ Payment OK').disabled).toBe(true);expect(button('Record payment')).toBeTruthy();expect(container.textContent).toContain('2 paid');
});


test.each(['ADMIN','SERVER'])('overdue popup includes pending and partly paid bills for %s but excludes future and settled old bills',async(role)=>{
 const rows=[{...due,account_name:'OVERDUE PENDING',due_date:'2026-11-01'},
 {...due,id:2,account_name:'OVERDUE PARTIAL',due_date:'2026-11-02',paid_amount:60,pending_amount:40,status:'PART_PAID'},
 {...due,id:3,account_name:'OLD SETTLED',due_date:'2026-11-02',paid_amount:100,pending_amount:0,status:'PAID',payments:[{payment_date:'2026-11-03'}]},
 {...due,id:4,account_name:'FUTURE ONLY',due_date:'2026-11-12'},
 {...due,id:5,account_name:'PAID TODAY',due_date:'2026-11-01',paid_amount:100,pending_amount:0,status:'PAID',payments:[{payment_date:mockDay}]},
 {...due,id:6,account_name:'REVERSED OLD',due_date:'2026-11-01',pending_amount:0,payments:[{payment_date:mockDay,reversed_date:mockDay}]}];
 api.get.mockResolvedValue({data:{...view(),rows}});
 await act(async()=>root.render(<PaymentDiaryReminder user={{username:'testuser',role}}/>));
 expect(container.querySelector('[role="dialog"]')).toBeTruthy();
 for(const name of ['OVERDUE PENDING','OVERDUE PARTIAL','PAID TODAY'])expect(container.textContent).toContain(name);
 for(const name of ['OLD SETTLED','FUTURE ONLY','REVERSED OLD'])expect(container.textContent).not.toContain(name);
 expect(container.textContent).toContain('3 bills');expect(container.textContent).toContain('2 pending');
 await act(async()=>Simulate.click(button('Close for today')));
 await act(async()=>jest.advanceTimersByTime(60000));expect(container.querySelector('[role="dialog"]')).toBeNull();
 await act(async()=>root.render(<PaymentDiaryReminder key="new-login" user={{username:'testuser',role}}/>));
 expect(container.querySelector('[role="dialog"]')).toBeNull();
 await act(async()=>root.render(<PaymentDiaryReminder key="other-login" user={{username:'differentuser',role}}/>));
 expect(container.querySelector('[role="dialog"]')).toBeTruthy();
 expect(api.post).not.toHaveBeenCalled();
});
