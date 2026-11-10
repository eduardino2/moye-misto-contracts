#!/usr/bin/env node
// Перевіряє, що кожен приклад у fixtures/ відповідає своїй схемі у schemas/.
// Без залежностей. Запуск із кореня репозиторію: node tools/check-fixtures.mjs
//
// Відповідність за назвою файлу:
//   fixtures/<контракт>/<назва>.<сценарій>.json  ->  schemas/<контракт>.schema.json#/$defs/<назва>
//
// Перевірка розуміє лише ту частину JSON Schema, якою користується контракт
// (перелік у KEYWORDS). Невідоме ключове слово у схемі — помилка, щоб правило
// не лишилось неперевіреним непомітно.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schemasDir = join(root, 'schemas');
const fixturesDir = join(root, 'fixtures');

const ANNOTATIONS = new Set(['$schema', '$id', '$defs', '$comment', 'title', 'description', 'format', 'examples', 'default']);
const KEYWORDS = new Set([
  '$ref', 'type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items',
  'anyOf', 'oneOf', 'not', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern',
]);

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));

const schemaCache = new Map();
function loadSchema(file) {
  if (!schemaCache.has(file)) {
    const path = join(schemasDir, file);
    if (!existsSync(path)) throw new Error(`Немає файлу схеми: schemas/${file}`);
    schemaCache.set(file, readJson(path));
  }
  return schemaCache.get(file);
}

function resolveRef(ref, currentFile) {
  const [filePart, pointer = ''] = ref.split('#');
  const file = filePart || currentFile;
  let node = loadSchema(file);
  for (const raw of pointer.split('/').filter(Boolean)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object' || !(key in node)) {
      throw new Error(`Посилання ${ref} (у ${currentFile}) нікуди не веде`);
    }
    node = node[key];
  }
  return { schema: node, file };
}

function matchesType(value, type) {
  switch (type) {
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    default: throw new Error(`Невідомий тип у схемі: ${type}`);
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function validate(value, schema, file, path, errors) {
  if (schema === true) return;
  if (schema === false) { errors.push(`${path}: значення не дозволене`); return; }
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error(`${file}: схема має бути об'єктом (${path})`);
  }
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) {
      throw new Error(`${file}: ключове слово "${key}" не підтримується перевіркою (${path})`);
    }
  }

  if (schema.$ref !== undefined) {
    const target = resolveRef(schema.$ref, file);
    validate(value, target.schema, target.file, path, errors);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${path}: очікується ${types.join(' або ')}, отримано ${JSON.stringify(value)?.slice(0, 60)}`);
      return;
    }
  }
  if (schema.const !== undefined && !same(value, schema.const)) {
    errors.push(`${path}: має дорівнювати ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum !== undefined && !schema.enum.some((item) => same(item, value))) {
    errors.push(`${path}: ${JSON.stringify(value)} немає серед ${JSON.stringify(schema.enum)}`);
  }
  if (schema.not !== undefined) {
    const inner = [];
    validate(value, schema.not, file, path, inner);
    if (inner.length === 0) errors.push(`${path}: значення підпадає під заборонену схему (not)`);
  }
  for (const keyword of ['anyOf', 'oneOf']) {
    if (schema[keyword] === undefined) continue;
    const results = schema[keyword].map((branch) => {
      const inner = [];
      validate(value, branch, file, path, inner);
      return inner;
    });
    const passed = results.filter((inner) => inner.length === 0).length;
    const ok = keyword === 'anyOf' ? passed >= 1 : passed === 1;
    if (!ok) {
      const closest = results.reduce((a, b) => (b.length < a.length ? b : a));
      errors.push(`${path}: не відповідає ${keyword} (підійшло варіантів: ${passed}). Найближчий варіант: ${closest.slice(0, 3).join('; ')}`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: менше за ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: більше за ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) errors.push(`${path}: коротше за ${schema.minLength}`);
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) errors.push(`${path}: довше за ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: "${value.slice(0, 60)}" не відповідає шаблону ${schema.pattern}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: елементів менше за ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: елементів більше за ${schema.maxItems}`);
    if (schema.items !== undefined) {
      value.forEach((item, index) => validate(item, schema.items, file, `${path}[${index}]`, errors));
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const name of schema.required ?? []) {
      if (!(name in value)) errors.push(`${path}: немає обов'язкового поля "${name}"`);
    }
    for (const [name, item] of Object.entries(value)) {
      if (name in properties) {
        validate(item, properties[name], file, `${path}.${name}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: зайве поле "${name}"`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validate(item, schema.additionalProperties, file, `${path}.${name}`, errors);
      }
    }
  }
}

// Обходить усю схему: ловить непідтримувані ключові слова й биті посилання навіть там,
// куди не дійшов жоден приклад.
function lintSchema(node, file, path) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((item, i) => lintSchema(item, file, `${path}[${i}]`)); return; }
  for (const [key, child] of Object.entries(node)) {
    if (key === '$ref') resolveRef(child, file);
    if (key === 'properties' || key === '$defs') {
      for (const [name, sub] of Object.entries(child)) lintSchema(sub, file, `${path}/${key}/${name}`);
    } else if (['items', 'not', 'additionalProperties', 'anyOf', 'oneOf'].includes(key)) {
      lintSchema(child, file, `${path}/${key}`);
    } else if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) {
      throw new Error(`${file}: ключове слово "${key}" не підтримується перевіркою (${path})`);
    }
  }
}

let failed = 0;
let checked = 0;
const usedDefs = new Set();

try {
  for (const file of readdirSync(schemasDir).filter((name) => name.endsWith('.schema.json')).sort()) {
    const schema = loadSchema(file);
    for (const [name, def] of Object.entries(schema.$defs ?? {})) lintSchema(def, file, `#/$defs/${name}`);
  }

  for (const contract of readdirSync(fixturesDir).sort()) {
    const dir = join(fixturesDir, contract);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir).filter((item) => item.endsWith('.json')).sort()) {
      const label = `fixtures/${contract}/${name}`;
      const defName = name.split('.')[0];
      const schemaFile = `${contract}.schema.json`;
      const errors = [];
      try {
        const def = loadSchema(schemaFile).$defs?.[defName];
        if (!def) throw new Error(`у schemas/${schemaFile} немає $defs/${defName}`);
        usedDefs.add(`${schemaFile}#${defName}`);
        validate(readJson(join(dir, name)), def, schemaFile, '$', errors);
      } catch (error) {
        errors.push(error.message);
      }
      checked += 1;
      if (errors.length > 0) {
        failed += 1;
        console.log(`ПОМИЛКА  ${label}`);
        errors.slice(0, 20).forEach((message) => console.log(`         ${message}`));
      } else {
        console.log(`ок       ${label}`);
      }
    }
  }
} catch (error) {
  console.error(`ПОМИЛКА  ${error.message}`);
  process.exit(1);
}

console.log(`\nПеревірено прикладів: ${checked}, з помилками: ${failed}.`);
process.exit(failed > 0 ? 1 : 0);
