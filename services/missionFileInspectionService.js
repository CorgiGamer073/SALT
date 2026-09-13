'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const MAX_FILE_BYTES = 5 * 1024 * 1024;

function inspectionError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function validateRelativeFile(fileName) {
  if (typeof fileName !== 'string' || fileName.length > 1024 ||
      /[\\\\%:]/.test(fileName) || [...fileName].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      fileName.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    throw inspectionError('INVALID_PATH', 'Invalid working-copy file path');
  }
  if (!/\.(xml|json)$/i.test(fileName)) {
    throw inspectionError('UNSUPPORTED_FILE', 'Only XML and JSON working copies can be read', 415);
  }
}
const { TextDecoder } = require('util');
const { openContainedFileSync, openContainedDirectorySync } = require('../utils/safePath');

function openRegularFile(root, fileName) {
  // Reject static nonregular files. The shared helper also opens nonblocking
  // and no-follow; a FIFO/symlink swap cannot block it before the fstat check.
  // Compare descriptor identity before consuming any bytes.
  const parent = openContainedDirectorySync(root, path.posix.dirname(fileName));
  try {
    const stat = fs.lstatSync(`/proc/self/fd/${parent.fd}/${path.posix.basename(fileName)}`);
    if (!stat.isFile() || stat.isSymbolicLink()) throw inspectionError('INVALID_PATH', 'Invalid working-copy file path');
    const opened = openContainedFileSync(root, fileName);
    if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => stat[key] !== opened.stat[key])) {
      fs.closeSync(opened.fd);
      throw inspectionError('FILE_CHANGED', 'Working copy changed while opening; reload and retry', 409);
    }
    return opened;
  } finally {
    fs.closeSync(parent.fd);
  }
}

function readSnapshot(root, fileName, maxBytes = MAX_FILE_BYTES) {
  validateRelativeFile(fileName);
  let fd;
  try {
    ({ fd } = openRegularFile(root, fileName));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw inspectionError('INVALID_PATH', 'Invalid working-copy file path');
    if (stat.size > maxBytes) throw inspectionError('FILE_TOO_LARGE', 'Working copy exceeds the read size limit', 413);
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw inspectionError('FILE_CHANGED', 'Working copy changed while reading; reload and retry', 409);
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => stat[key] !== after[key])) {
      throw inspectionError('FILE_CHANGED', 'Working copy changed while reading; reload and retry', 409);
    }
    return {
      fileName,
      filePath: fileName,
      content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
      hash: crypto.createHash('sha256').update(bytes).digest('hex'),
      parsedData: null,
      isLocal: true,
      source: { kind: 'local_working_copy', modifiedAt: stat.mtime.toISOString(), providerFreshness: 'unknown' },
    };
  } catch (error) {
    if (error.status) throw error;
    if (error.code === 'ENOENT') throw inspectionError('ENOENT', 'File not found. Please sync files first.', 404);
    if (error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') {
      throw inspectionError('INVALID_UTF8', 'Working copy is not valid UTF-8', 422);
    }
    throw inspectionError('INVALID_PATH', 'Working copy could not be safely read');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function exactMission(fileName) {
  const parts = fileName.split('/');
  const index = parts.indexOf('mpmissions');
  if (index < 0 || index !== parts.lastIndexOf('mpmissions') || parts.length < index + 3) return null;
  return parts.slice(0, index + 2).join('/');
}

const REGISTRATION_LIMITS = Object.freeze({ maxBytes: 128 * 1024, maxNodes: 4096, maxFiles: 512, maxDepth: 16, maxMissions: 16 });
const CE_TYPES = new Map([['types', 'types.xml'], ['events', 'events.xml'],
  ['spawnabletypes', 'cfgspawnabletypes.xml'], ['globals', 'globals.xml'], ['economy', 'economy.xml']]);

function registrationMetadata(root, fileName, cache = new Map()) {
  const mission = exactMission(fileName);
  if (!mission) return { diagnostics: [{ code: 'CE_MISSION_UNRESOLVED', message: 'No unambiguous exact mission directory is available for CE typing' }] };
  if (!cache.has(mission) && cache.size >= REGISTRATION_LIMITS.maxMissions) {
    return { diagnostics: [{ code: 'CE_REGISTRATION_LIMIT', message: 'CE metadata inspection reached its mission limit' }] };
  }
  if (!cache.has(mission)) {
    const registrations = new Map();
    let diagnostic;
    try {
      const content = readSnapshot(root, `${mission}/cfgeconomycore.xml`, REGISTRATION_LIMITS.maxBytes).content;
      const { XMLParser, XMLValidator } = require('fast-xml-parser');
      const stack = [];
      const caseKeys = new Set();
      let folder;
      let nodes = 0;
      let files = 0;
      let roots = 0;
      const invalid = () => { throw inspectionError('CE_REGISTRATION_INVALID', 'CE registration is unsafe, malformed, or exceeds inspection limits'); };
      if (/<!DOCTYPE|<!\[CDATA\[/i.test(content) || XMLValidator.validate(content) !== true) invalid();
      const openTag = node => {
        if (++nodes > REGISTRATION_LIMITS.maxNodes || stack.length >= REGISTRATION_LIMITS.maxDepth) invalid();
        const parent = stack.join('/');
        if (!stack.length && (++roots !== 1 || node.name !== 'economycore')) invalid();
        if (node.name === 'ce') {
          if (parent !== 'economycore' || Object.keys(node.attributes).join() !== 'folder') invalid();
          folder = node.attributes.folder;
          if (folder !== '.') validateRelativeFile(`${folder}/registration.xml`);
        }
        if (parent === 'economycore/ce' && node.name !== 'file') invalid();
        if (parent.startsWith('economycore/ce/file')) invalid();
        if (node.name === 'file') {
          if (parent !== 'economycore/ce' || ++files > REGISTRATION_LIMITS.maxFiles ||
              Object.keys(node.attributes).sort().join() !== 'name,type') invalid();
          const { name, type } = node.attributes;
          if (!name || name.includes('/') || !name.endsWith('.xml') || !CE_TYPES.has(type)) invalid();
          validateRelativeFile(name);
          const target = `${mission}/${folder === '.' ? '' : `${folder}/`}${name}`;
          const caseKey = target.toLowerCase();
          if (caseKeys.has(caseKey)) {
            throw inspectionError('CE_REGISTRATION_AMBIGUOUS', 'CE registration contains duplicate or conflicting file targets');
          }
          caseKeys.add(caseKey);
          registrations.set(target, CE_TYPES.get(type));
        }
        stack.push(node.name);
      };
      // The 128 KiB snapshot bounds parse expansion; traversal independently
      // limits structure before recursing into children. Use a declared dependency.
      const tree = new XMLParser({ preserveOrder: true, ignoreAttributes: false,
        attributeNamePrefix: '', trimValues: false, parseTagValue: false,
        parseAttributeValue: false, ignoreDeclaration: true, ignorePiTags: true }).parse(content);
      const visit = elements => {
        for (const element of elements) {
          const name = Object.keys(element).find(key => key !== ':@');
          if (name === '#text') {
            if (stack.includes('ce') && String(element[name]).trim()) invalid();
            continue;
          }
          openTag({ name, attributes: element[':@'] || {} });
          visit(element[name]);
          stack.pop();
        }
      };
      visit(tree);
      if (roots !== 1) invalid();
    } catch (error) {
      registrations.clear();
      diagnostic = error.code === 'ENOENT'
        ? { code: 'CE_REGISTRATION_UNAVAILABLE', message: 'No exact mission CE registration is available' }
        : { code: error.code === 'CE_REGISTRATION_AMBIGUOUS' ? error.code : 'CE_REGISTRATION_INVALID',
          message: 'CE document type omitted: registration is unsafe, malformed, ambiguous, or exceeds inspection limits' };
    }
    cache.set(mission, { registrations, diagnostic });
  }
  const { registrations, diagnostic } = cache.get(mission);
  const documentType = registrations.get(fileName);
  return { ...(documentType ? { documentType } : {}), diagnostics: diagnostic ? [diagnostic] : [] };
}

function readWorkingCopyFile(root, fileName) {
  const result = readSnapshot(root, fileName);
  return { ...result, ...registrationMetadata(root, fileName) };
}

const DISCOVERY_LIMITS = Object.freeze({ maxDepth: 8, maxEntries: 10000, maxFiles: 1000 });

function discoverWorkingCopyFiles(root, options = {}) {
  const limits = {};
  for (const [key, ceiling] of Object.entries(DISCOVERY_LIMITS)) {
    limits[key] = Number.isInteger(options[key]) && options[key] >= 0 ? Math.min(options[key], ceiling) : ceiling;
  }
  const files = Object.create(null);
  const registrationCache = new Map();
  const diagnostics = new Map();
  let scannedEntries = 0;
  let fileCount = 0;
  let truncated = false;
  const truncate = code => {
    truncated = true;
    diagnostics.set(code, { code, message: 'Working-copy discovery was truncated by a safety limit' });
  };
  function walk(relativeDir = '.', depth = 0) {
    const { fd } = openContainedDirectorySync(root, relativeDir);
    let directory;
    const entries = [];
    try {
      directory = fs.opendirSync(`/proc/self/fd/${fd}`, { bufferSize: 32 });
      let entry;
      while ((entry = directory.readSync())) {
        if (scannedEntries >= limits.maxEntries) {
          // Never return an arbitrary native-readdir prefix. Sorting is valid
          // only after this directory was enumerated completely.
          truncate('MAX_ENTRIES');
          return;
        }
        scannedEntries += 1;
        entries.push(entry);
      }
    } finally {
      if (directory) directory.closeSync();
      fs.closeSync(fd);
    }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const relativePath = relativeDir === '.' ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (/^(?:storage(?:_.*)?|logs?|node_modules)$/i.test(entry.name)) continue;
        if (depth >= limits.maxDepth) { truncate('MAX_DEPTH'); continue; }
        if (diagnostics.has('MAX_ENTRIES')) continue;
        walk(relativePath, depth + 1);
      } else if (entry.isFile() && /\.(xml|json)$/i.test(entry.name)) {
        if (fileCount >= limits.maxFiles) { truncate('MAX_FILES'); return; }
        let opened;
        try {
          validateRelativeFile(relativePath);
          opened = openRegularFile(root, relativePath);
          fileCount += 1;
          files[relativePath] = {
            description: `Mission file: ${relativePath}`,
            type: path.extname(entry.name).slice(1).toLowerCase(),
            path: relativePath, relativePath, size: opened.stat.size,
            ...registrationMetadata(root, relativePath, registrationCache),
          };
        } finally {
          if (opened) fs.closeSync(opened.fd);
        }
      }
    }
  }
  walk();
  if (Object.values(files).some(file => file.diagnostics?.some(item => item.code === 'CE_REGISTRATION_LIMIT'))) {
    truncate('CE_REGISTRATION_LIMIT');
  }
  return {
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
    truncated, diagnostics: [...diagnostics.values()], scannedEntries, limits,
  };
}

module.exports = { readWorkingCopyFile, discoverWorkingCopyFiles, MAX_FILE_BYTES, DISCOVERY_LIMITS };
