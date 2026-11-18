/* BackendKit — Copyright (c) 2026 Hirdyansh Pandey. MIT licensed. */
function csvCheck(text) {
  if (!text.trim()) throw Error('Paste a CSV file first.');
  let rows=[], row=[], cell='', quoted=false, closed=false;
  for(let i=0;i<text.length;i++) {
    let c=text[i];
    if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=c;continue;}
    if(closed && c!==',' && c!=='\n' && c!=='\r') throw Error('Unexpected text after a closing quote.');
    if(c==='"'){if(cell)throw Error('A quote inside an unquoted field must be escaped.');quoted=true;}
    else if(c===','){row.push(cell);cell='';closed=false;}
    else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell='';closed=false;}
    else cell+=c;
  }
  if(quoted)throw Error('Unclosed quoted field.');
  if(cell||row.length||closed) {row.push(cell);rows.push(row);}
  const header=rows.shift().map((x,i)=> (i===0?x.replace(/^\uFEFF/,''):x).trim());
  const issues=[]; const seen=new Set();
  header.forEach((x,i)=>{if(!x)issues.push(`Header ${i+1}: empty name`);if(seen.has(x))issues.push(`Header ${i+1}: duplicate name ${JSON.stringify(x)}`);seen.add(x);});
  let empty=0;
  rows.forEach((r,i)=>{if(r.length!==header.length)issues.push(`Record ${i+2}: ${r.length} columns; expected ${header.length}`);r.forEach(x=>{if(!x.trim())empty++;});});
  return `${rows.length} data records · ${header.length} columns\n${empty} empty cells\n\n${issues.length?issues.slice(0,100).join('\n')+(issues.length>100?'\n… additional issues omitted':''):'✓ No header or row-width issues found.'}`;
}
function envDiff(a,b){
  function keys(s){const found=new Set(),invalid=[];s.split(/\r?\n/).forEach((line,i)=>{line=line.trim();if(!line||line.startsWith('#'))return;const m=line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);if(m)found.add(m[1]);else invalid.push(i+1);});return {found,invalid};}
  const x=keys(a),y=keys(b),only=(u,v)=>[...u].filter(k=>!v.has(k)).sort().join('\n')||'(none)';
  return `Only in source / missing from target:\n${only(x.found,y.found)}\n\nOnly in target:\n${only(y.found,x.found)}\n\nShared keys: ${[...x.found].filter(k=>y.found.has(k)).length}\nUnparsed source lines: ${x.invalid.join(', ')||'none'}\nUnparsed target lines: ${y.invalid.join(', ')||'none'}\n\nValues are not compared or displayed.`;
}
function pydantic(text){
  const data=JSON.parse(text);if(!data||Array.isArray(data)||typeof data!=='object')throw Error('Paste a JSON object at the root.');
  const defs=[],names=new Set(['BaseModel','Field','Any']),keywords=new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield model_config'.split(' '));
  const unique=(base,set)=>{let n=base,i=2;while(set.has(n))n=base+i++;set.add(n);return n;};
  function cls(v,raw){let name=raw.replace(/[^A-Za-z0-9]+/g,' ').split(' ').filter(Boolean).map(s=>s[0].toUpperCase()+s.slice(1)).join('')||'NestedModel';if(/^\d/.test(name))name='Model'+name;name=unique(name,names);const used=new Set();let fields=[];
    for(const [key,val] of Object.entries(v)){let field=key.replace(/[^A-Za-z0-9_]/g,'_');if(!field||/^[\d_]/.test(field))field='field_'+field;if(keywords.has(field)||field.startsWith('model_'))field='field_'+field;field=unique(field,used);const type=hint(val,name+field);const alias=field!==key;fields.push(`    ${field}: ${type}${alias?' = Field('+ (val===null?'default=None, ':'')+'alias='+JSON.stringify(key)+')':val===null?' = None':''}`);}
    defs.push(`class ${name}(BaseModel):\n${fields.length?fields.join('\n'):'    pass'}`);return name;
  }
  function hint(v,name){if(v===null)return 'Any';if(Array.isArray(v)){if(!v.length)return 'list[Any]';const types=[...new Set(v.map((x,i)=>hint(x,name+'Item'+i)))];return `list[${types.length===1?types[0]:'Any'}]`;}if(typeof v==='object')return cls(v,name);if(typeof v==='boolean')return 'bool';if(typeof v==='number')return Number.isInteger(v)?'int':'float';return 'str';}
  cls(data,'GeneratedModel');return 'from typing import Any\nfrom pydantic import BaseModel, Field\n\n\n'+defs.join('\n\n\n')+'\n';
}
function postgres(text){const entries=[
 ['23505','duplicate key','Unique constraint violation','Inspect the named unique constraint and the conflicting input. Use ON CONFLICT only when an explicit business rule defines whether to skip or update.'],
 ['23503','foreign key','Foreign key violation','Check that the referenced parent row exists and that you use the correct tenant/schema. For deletes, inspect dependent child rows.'],
 ['23502','null value','NOT NULL violation','Identify the named column. Verify payload mapping, defaults and required fields; an explicit NULL does not use a column default.'],
 ['22P02','invalid input syntax','Invalid text representation','Check the parameter type. An empty string cannot be cast to an integer. Normalize optional blanks to NULL only if the column permits it.'],
 ['22001','value too long','String length exceeded','Inspect the target varchar(n) column and input length. Confirm the domain requirement before changing the schema or rejecting the input.'],
 ['42P01','does not exist','Undefined table or object','Check table spelling, migration state, quoted case and search_path. A generic “does not exist” message may also refer to other object types; inspect the complete error.'],
 ['42703','column','Undefined column','For SQLSTATE 42703, verify column spelling, quoted case and applied migrations. A message mentioning a column alone is insufficient to identify this error.'],
 ['25P02','current transaction is aborted','Transaction already failed','Find the first error in the transaction. Roll back the failed transaction before retrying. With SQLAlchemy, use rollback or a scoped transaction context.'],
 ['40P01','deadlock detected','Deadlock detected','Inspect server deadlock logs. Acquire locks in a consistent order, keep transactions short and retry the whole transaction with bounded backoff.'],
 ['40001','could not serialize','Serialization failure','Retry the entire transaction with a bounded retry policy; repeating only the last statement is insufficient.'],
 ['53300','too many connections','Connection limit reached','Inspect active sessions and pool settings across all workers. Check connection leaks before raising max_connections.']];
 const upper=text.toUpperCase();let e=entries.find(e=>new RegExp('\\b'+e[0]+'\\b').test(upper));if(!e)e=entries.find(e=>e[0]!=='42703'&&text.toLowerCase().includes(e[1]));
 return e?`${e[0]} · ${e[2]}\n\n${e[3]}\n\nReference: https://www.postgresql.org/docs/current/errcodes-appendix.html`:'No supported error matched. Paste the SQLSTATE code or a complete error message. Supported: '+entries.map(e=>e[0]).join(', ');
}
if(typeof module!=='undefined')module.exports={csvCheck,envDiff,pydantic,postgres};
if(typeof document!=='undefined'){
 const $=id=>document.getElementById(id),input=$('input'),output=$('output');
 $('sample').onclick=()=>{input.value=window.EXAMPLE;if($('input2'))$('input2').value='DATABASE_URL=placeholder\nAPI_KEY=placeholder';};
 $('clear').onclick=()=>{input.value='';if($('input2'))$('input2').value='';output.textContent='Your result will appear here.';$('status').textContent='';};
 $('run').onclick=()=>{try{if(new Blob([input.value+($('input2')?.value||'')]).size>2*1024*1024)throw Error('Input exceeds 2 MB. Please use a smaller sample.');if(!input.value.trim())throw Error('Paste your input or load an example.');output.textContent=window.TOOL==='csv-import-checker'?csvCheck(input.value):window.TOOL==='env-key-diff'?envDiff(input.value,$('input2').value):window.TOOL==='json-to-pydantic'?pydantic(input.value):postgres(input.value);$('status').textContent='';}catch(e){output.textContent='Please check your input: '+e.message;}};
 $('copy').onclick=async()=>{try{await navigator.clipboard.writeText(output.textContent);$('status').textContent='Copied.';}catch{$('status').textContent='Select the result and copy it manually.';}};
}
