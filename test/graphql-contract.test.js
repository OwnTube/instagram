'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { selectionTree, completeToContract, missingPaths } = require('../src/runtime/graphqlContract');

const scalar = (name) => ({ alias: null, args: null, kind: 'ScalarField', name, storageKey: null });
const linked = (name, selections, extra = {}) => ({ alias: null, args: null, kind: 'LinkedField', name, plural: false, selections, storageKey: null, ...extra });

// Shape of PolarisFeedTimelineRootV2Query's normalisation AST around the
// client resolver client__feedDedupedIds (reduced).
const operation = [
  linked('connection', [
    linked('edges', [linked('node', [linked('media', [scalar('id'), linked('user', [scalar('pk')]), { kind: 'ClientExtension', selections: [scalar('__id'), scalar('is_hidden')] }], { concreteType: 'XDTMediaDict' })], { concreteType: 'XDTFeedItem' })], { plural: true, concreteType: 'Edge' }),
    {
      kind: 'RelayResolver',
      name: 'client__feedDedupedIds',
      fragment: {
        kind: 'InlineFragment',
        type: 'Connection',
        abstractKey: null,
        selections: [
          linked('edges', [linked('node', [linked('media', [scalar('id'), scalar('view_state_item_type'), scalar('brs_severity')], { concreteType: 'XDTMediaDict' })], { concreteType: 'XDTFeedItem' })], { plural: true, concreteType: 'Edge' }),
          { kind: 'ClientExtension', selections: [scalar('unfollowed_users')] },
        ],
      },
    },
  ], { concreteType: 'Connection' }),
];

test('server fields a client resolver reads are part of the contract', () => {
  const tree = selectionTree(operation);
  const value = { connection: { __typename: 'Connection', edges: [{ node: { media: { id: '1_2', user: { pk: '2' } } } }] } };
  assert.deepEqual(missingPaths(tree, value).sort(), ['connection.edges.node.media.brs_severity', 'connection.edges.node.media.view_state_item_type']);
  completeToContract(tree, value);
  const media = value.connection.edges[0].node.media;
  assert.equal(media.view_state_item_type, null);
  assert.equal(media.brs_severity, null);
  assert.deepEqual(missingPaths(tree, value), []);
});

test('client extension fields and the resolver field itself are never written', () => {
  const tree = selectionTree(operation);
  const value = { connection: { __typename: 'Connection', edges: [{ node: { media: { id: '1_2', user: { pk: '2' } } } }] } };
  completeToContract(tree, value);
  assert.equal('unfollowed_users' in value.connection, false);
  assert.equal('client__feedDedupedIds' in value.connection, false);
  const media = value.connection.edges[0].node.media;
  assert.equal('is_hidden' in media, false);
  assert.equal('__id' in media, false);
});

test('a type-specific selection applies only to records of that type', () => {
  const tree = selectionTree([linked('item', [scalar('id'), { kind: 'InlineFragment', type: 'Photo', abstractKey: null, selections: [scalar('width')] }])]);
  const photo = { item: { __typename: 'Photo', id: '1' } };
  const video = { item: { __typename: 'Video', id: '2' } };
  completeToContract(tree, photo);
  completeToContract(tree, video);
  assert.equal(photo.item.width, null);
  assert.equal('width' in video.item, false);
});
