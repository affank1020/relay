// Subset of JSON Schema needed for externally discovered MCP tool inputs.
// Unsupported validation keywords fail closed instead of being ignored.
type Schema = Record<string,unknown>;
const metadata=new Set(['$schema','title','description','default','examples','deprecated','readOnly','writeOnly']);
const constraints=new Set(['type','properties','required','additionalProperties','items',
  'minimum','maximum','exclusiveMinimum','exclusiveMaximum','minLength','maxLength',
  'minItems','maxItems','minProperties','maxProperties','enum','const',
  'anyOf','oneOf','allOf','format']);
const plain=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const numeric=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
export function supportedSchema(v:unknown,depth=0):v is Schema {
  if(!plain(v)||depth>8||Object.keys(v).some(k=>!metadata.has(k)&&!constraints.has(k)))return false;
  if(v.type!==undefined && !['object','array','string','number','integer','boolean','null'].includes(String(v.type)))return false;
  if(v.properties!==undefined && (!plain(v.properties)||Object.values(v.properties).some(s=>!supportedSchema(s,depth+1))))return false;
  if(v.required!==undefined && (!Array.isArray(v.required)||v.required.some(s=>typeof s!=='string')))return false;
  if(v.additionalProperties!==undefined && typeof v.additionalProperties!=='boolean' && !supportedSchema(v.additionalProperties,depth+1))return false;
  if(v.items!==undefined && !supportedSchema(v.items,depth+1))return false;
  for(const keyword of ['anyOf','oneOf','allOf'] as const){
    const items=v[keyword];
    if(items!==undefined && (!Array.isArray(items)||!items.length||items.length>8||items.some(s=>!supportedSchema(s,depth+1))))return false;
  }
  for(const keyword of ['minimum','maximum','exclusiveMinimum','exclusiveMaximum','minLength','maxLength','minItems','maxItems','minProperties','maxProperties']){
    if(v[keyword]!==undefined && !numeric(v[keyword]))return false;
  }
  if(v.enum!==undefined && (!Array.isArray(v.enum)||v.enum.length>100))return false;
  if(v.format!==undefined && !['uuid','uri','date-time','email'].includes(String(v.format)))return false;
  return true;
}
function check(schema:Schema,value:unknown,depth:number):boolean {
  if(depth>12)return false;
  if(Array.isArray(schema.allOf)&&!schema.allOf.every(s=>check(s as Schema,value,depth+1)))return false;
  if(Array.isArray(schema.anyOf)&&!schema.anyOf.some(s=>check(s as Schema,value,depth+1)))return false;
  if(Array.isArray(schema.oneOf)&&schema.oneOf.filter(s=>check(s as Schema,value,depth+1)).length!==1)return false;
  if(schema.const!==undefined&&JSON.stringify(value)!==JSON.stringify(schema.const))return false;
  if(Array.isArray(schema.enum)&&!schema.enum.some(x=>JSON.stringify(x)===JSON.stringify(value)))return false;
  const type=schema.type as string|undefined;
  if(type==='null')return value===null;
  if(type==='boolean')return typeof value==='boolean';
  if(type==='number'||type==='integer'){
    if(!numeric(value)||(type==='integer'&&!Number.isInteger(value)))return false;
    if(numeric(schema.minimum)&&value<schema.minimum)return false;
    if(numeric(schema.maximum)&&value>schema.maximum)return false;
    if(numeric(schema.exclusiveMinimum)&&value<=schema.exclusiveMinimum)return false;
    if(numeric(schema.exclusiveMaximum)&&value>=schema.exclusiveMaximum)return false;
  }
  if(type==='string'){
    if(typeof value!=='string')return false;
    if(numeric(schema.minLength)&&value.length<schema.minLength)return false;
    if(numeric(schema.maxLength)&&value.length>schema.maxLength)return false;
    if(schema.format==='uuid'&&!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value))return false;
    if(schema.format==='email'&&!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value))return false;
    if(schema.format==='date-time'&&!Number.isFinite(Date.parse(value)))return false;
    if(schema.format==='uri'){try {new URL(value);}catch{return false;}}
  }
  if(type==='array'){
    if(!Array.isArray(value))return false;
    if(numeric(schema.minItems)&&value.length<schema.minItems)return false;
    if(numeric(schema.maxItems)&&value.length>schema.maxItems)return false;
    if(schema.items&&!value.every(v=>check(schema.items as Schema,v,depth+1)))return false;
  }
  if(type==='object'){
    if(!plain(value))return false;
    const keys=Object.keys(value);
    if(numeric(schema.minProperties)&&keys.length<schema.minProperties)return false;
    if(numeric(schema.maxProperties)&&keys.length>schema.maxProperties)return false;
    const properties=plain(schema.properties)?schema.properties:{};
    const required=Array.isArray(schema.required)?schema.required as string[]:[];
    if(required.some(k=>!Object.hasOwn(value,k)))return false;
    for(const key of keys){
      if(['__proto__','constructor','prototype'].includes(key))return false;
      if(Object.hasOwn(properties,key)){
        if(!check(properties[key] as Schema,value[key],depth+1))return false;
      }else if(schema.additionalProperties===false)return false;
      else if(plain(schema.additionalProperties)&&!check(schema.additionalProperties,value[key],depth+1))return false;
    }
  }
  return true;
}
export function validRemoteArguments(schema:Schema,value:unknown):boolean {
  try{
    const encoded=JSON.stringify(value);
    return encoded.length<=16_384 && supportedSchema(schema) && check(schema,value,0);
  }catch{return false;}
}
