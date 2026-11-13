import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { searchClosingAccounts } from '../api/client';

const labels = { NAMED_LEDGER: 'Named Ledger', LOCAL: 'Local vendor', NON_LOCAL: 'Non-Local vendor', CUSTOMER: 'Customer', HISTORY: 'Previous day-sheet name' };

export default function ClosingAccountInput({ index, inputRef, value, onChange, onFocus, vendors }) {
  const anchor=useRef(null);
  const [position,setPosition]=useState(null);
  const [open, setOpen] = useState(false);
  const [response, setResponse] = useState(null);
  const [active, setActive] = useState(-1);
  const query = value.trim();
  const listId = `closing-accounts-${index}`;
  const visible = open && query.length >= 3 && response?.query === query && response.vendors === vendors;
  const rows = visible ? response.rows.flatMap(row => row.kind === 'HISTORY'
    ? [row, { name: row.name, kind: 'CUSTOMER', fromHistory: true }].filter(option =>
        !option.fromHistory || !response.rows.some(other => other.kind === 'CUSTOMER' && other.name.toUpperCase() === row.name.toUpperCase()))
    : [row]) : [];

  useEffect(() => {
    if (!open || query.length < 3) return undefined;
    let current = true;
    const timer = setTimeout(async () => {
      try {
        const rows = await searchClosingAccounts(query, vendors);
        if (current) setResponse({ query, vendors, rows });
      } catch {
        if (current) setResponse({ query, vendors, rows: [], failed: true });
      }
    }, 150);
    return () => { current = false; clearTimeout(timer); };
  }, [open, query, vendors]);

  useLayoutEffect(()=>{
    if(!rows.length){setPosition(null);return undefined;}
    const place=()=>{const rect=anchor.current?.getBoundingClientRect();if(!rect)return;
      const height=Math.min(180,rows.length*40+8),below=window.innerHeight-rect.bottom;
      setPosition({position:'fixed',left:Math.max(8,Math.min(rect.left,window.innerWidth-Math.min(rect.width,window.innerWidth-16)-8)),top:below>=height+8?rect.bottom+4:Math.max(8,rect.top-height-4),width:Math.min(rect.width,window.innerWidth-16),maxHeight:height,overflowY:'auto',zIndex:10000,background:'#fff',border:'1px solid #79a687',borderRadius:5,boxShadow:'0 5px 18px #173d3030',padding:3});};
    place();window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    return()=>{window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
  },[rows.length,query,vendors]);

  function select(row) {
    onChange(row.name, row.kind === 'HISTORY' ? undefined : row.kind);
    setOpen(false);
    setActive(-1);
  }

  function keyDown(event) {
    if (event.key === 'Escape') setOpen(false);
    if (rows.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      setActive(i => event.key === 'ArrowDown' ? Math.min(i + 1, rows.length - 1) : Math.max(0, i - 1));
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (rows[active]) select(rows[active]);
      event.currentTarget.closest('tr')?.querySelector('.handover-remarks-input')?.focus();
    }
  }

  return <>
    <input ref={element=>{anchor.current=element;if(typeof inputRef==='function')inputRef(element);else if(inputRef)inputRef.current=element;}} className="field handover-details-input" value={value}
      aria-label={`Row ${index + 1} details`} role="combobox" aria-autocomplete="list"
      aria-expanded={Boolean(rows.length)} aria-controls={listId}
      aria-activedescendant={rows[active] ? `${listId}-${active}` : undefined}
      autoComplete="off" placeholder="Type 3 letters · Named Ledger"
      onFocus={() => { onFocus(); setOpen(true); }} onBlur={() => setOpen(false)}
      onChange={event => { setOpen(true); setActive(-1); onChange(event.target.value); }}
      onKeyDown={keyDown} />
    {rows.length > 0 && position && createPortal(<div role="listbox" id={listId} style={position}>
      {rows.map((row, i) => <button type="button" role="option" key={row.kind + ':' + row.name}
        id={`${listId}-${i}`} aria-selected={i === active} tabIndex={-1}
        style={{ display: 'block', width: '100%', textAlign: 'left', background: i === active ? '#def1df' : 'white' }}
        onMouseDown={event => event.preventDefault()} onClick={() => select(row)}>
        {row.name} · {row.fromHistory ? 'Use as customer' : labels[row.kind]}
      </button>)}
    </div>,document.body)}
    {visible && response.failed && <small>Account suggestions unavailable. Check the spelling before saving.</small>}
  </>;
}
