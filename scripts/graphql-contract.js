#!/usr/bin/env node
'use strict';

/**
 * Print the response tree a GraphQL operation selects, read from the client's
 * own compiled artifact in the stored bundles (src/runtime/graphqlContract.js).
 *
 *   node scripts/graphql-contract.js PolarisStoriesV3TrayContainerQuery [--json]
 */

const { buildModuleIndex } = require('../src/runtime/moduleIndex');
const { operationTree, loadArtifact } = require('../src/runtime/graphqlContract');

function print(tree, depth = 0, out = []) {
  for (const [key, sub] of Object.entries(tree)) {
    if (key === '__plural' || key === '__concrete') continue;
    const pad = '  '.repeat(depth);
    if (sub && typeof sub === 'object') {
      out.push(`${pad}${key}${sub.__plural ? '[]' : ''}${sub.__concrete ? ` : ${sub.__concrete}` : ''}`);
      print(sub, depth + 1, out);
    } else out.push(`${pad}${key}`);
  }
  return out;
}

const [name, flag] = process.argv.slice(2);
if (!name) {
  console.error('usage: node scripts/graphql-contract.js <OperationName> [--json]');
  process.exit(2);
}
const index = buildModuleIndex({ assetDir: '.cache/assets', documentDir: '.cache/documents', bootloaderDir: '.cache/bootloader' });
const tree = operationTree(index, name);
if (!tree) {
  console.error(`${name}.graphql is not in the stored bundles`);
  process.exit(1);
}
if (flag === '--json') console.log(JSON.stringify(tree, null, 2));
else {
  const artifact = loadArtifact(index, `${name}.graphql`);
  console.log(`# ${name} (${artifact.params && artifact.params.operationKind}) variables: ${(artifact.fragment.argumentDefinitions || []).map((a) => a.name).join(', ')}`);
  console.log(print(tree).join('\n'));
}
