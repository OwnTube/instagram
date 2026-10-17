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

// The real normalisation AST of IGDOmniPickerSearchResultsListQuery (Direct
// "New message" search): the list items are spread as `... on ShareSheetItem`
// (abstractKey `__isShareSheetItem`), so Relay matches the item fragments only
// for records carrying that discriminator.
const OMNIPICKER = require('./fixtures/omnipicker-search-operation.json').selections;
const { artifactPossibleTypes } = require('../src/runtime/graphqlContract');
const omnipickerPossible = artifactPossibleTypes({ kind: 'Request', operation: { kind: 'Operation', selections: OMNIPICKER } });
const possibleOf = (map) => (key) => map.get(key) || null;

test('an abstract inline fragment is recorded as its discriminator', () => {
  const tree = selectionTree(OMNIPICKER);
  assert.deepEqual(tree.xfb_combinedIGSearchQuery.search_messenger_contact_v2.__discriminators, ['__isShareSheetItem']);
});

test("the operation's own spreads show which types are possible", () => {
  // `... on ShareSheetItem` directly under a field of concrete type
  // ShareSheetUser, and `... on ShareSheetThread` inside that spread.
  assert.deepEqual([...omnipickerPossible.get('__isShareSheetItem')].sort(), ['ShareSheetThread', 'ShareSheetUser']);
});

test('a compatible record gets the discriminator; an incompatible or unknown type does not', () => {
  const tree = selectionTree(OMNIPICKER);
  const items = [
    { __typename: 'ShareSheetUser', share_sheet_item_id: '5', pk: '5' },
    { __typename: 'ShareSheetThread', share_sheet_item_id: '9', thread_id: '9' },
    { __typename: 'XDTUserDict', share_sheet_item_id: '7' },
  ];
  completeToContract(tree, { xfb_combinedIGSearchQuery: { search_messenger_contact_v2: items } }, possibleOf(omnipickerPossible));
  assert.equal(items[0].__isShareSheetItem, 'ShareSheetUser');
  assert.equal(items[1].__isShareSheetItem, 'ShareSheetThread');
  assert.ok(!('__isShareSheetItem' in items[2]), 'a type not shown to be a ShareSheetItem gets none');
  const unknown = [{ __typename: 'ShareSheetUser', share_sheet_item_id: '5' }];
  completeToContract(tree, { xfb_combinedIGSearchQuery: { search_messenger_contact_v2: unknown } });
  assert.ok(!('__isShareSheetItem' in unknown[0]), 'no evidence (no possible types), no discriminator');
});

test('an explicit discriminator value is kept', () => {
  const tree = selectionTree(OMNIPICKER);
  const item = { __typename: 'ShareSheetUser', __isShareSheetItem: 'ShareSheetUser', share_sheet_item_id: '5' };
  const odd = { __typename: 'ShareSheetThread', __isShareSheetItem: 'AsAnswered', share_sheet_item_id: '6' };
  completeToContract(tree, { xfb_combinedIGSearchQuery: { search_messenger_contact_v2: [item, odd] } }, possibleOf(omnipickerPossible));
  assert.equal(item.__isShareSheetItem, 'ShareSheetUser');
  assert.equal(odd.__isShareSheetItem, 'AsAnswered');
});

test('nested abstract fragments: each level gets its own discriminator from its own evidence', () => {
  // items: `... on Actor` (abstract) holding `owner { ... on Node }` (abstract,
  // under a field of concrete type XDTUserDict) and `... on Page` (concrete
  // inside the Actor spread).
  const selections = [
    linked('items', [
      scalar('__typename'),
      { kind: 'InlineFragment', type: 'Actor', abstractKey: '__isActor', selections: [
        scalar('name'),
        linked('owner', [scalar('__typename'), { kind: 'InlineFragment', type: 'Node', abstractKey: '__isNode', selections: [scalar('id')] }], { concreteType: 'XDTUserDict' }),
        { kind: 'InlineFragment', type: 'Page', abstractKey: null, selections: [scalar('category')] },
      ] },
    ], { plural: true }),
  ];
  const possible = artifactPossibleTypes({ kind: 'Request', operation: { kind: 'Operation', selections } });
  assert.deepEqual([...possible.get('__isActor')], ['Page']);
  assert.deepEqual([...possible.get('__isNode')], ['XDTUserDict']);
  const tree = selectionTree(selections);
  const page = { __typename: 'Page', name: 'p', owner: { __typename: 'XDTUserDict', id: '1' } };
  const user = { __typename: 'User', name: 'u', owner: { __typename: 'Other', id: '2' } };
  completeToContract(tree, { items: [page, user] }, possibleOf(possible));
  assert.equal(page.__isActor, 'Page');
  assert.equal(page.owner.__isNode, 'XDTUserDict');
  assert.ok(!('__isActor' in user) && !('__isNode' in user.owner), 'types without evidence get neither');
});

test("a fragment artifact's own spreads count as evidence", () => {
  // IGDShareSheetDialogItemList_ShareSheetItems (shape of the real fragment).
  const fragment = {
    kind: 'Fragment',
    type: 'ShareSheetItem',
    abstractKey: '__isShareSheetItem',
    selections: [
      scalar('share_sheet_item_id'),
      { kind: 'InlineFragment', type: 'ShareSheetUser', abstractKey: null, selections: [{ kind: 'FragmentSpread', name: 'IGDRecipientUserListItem_ShareSheetUser' }] },
      { kind: 'InlineFragment', type: 'ShareSheetThread', abstractKey: null, selections: [{ kind: 'FragmentSpread', name: 'IGDRecipientThreadListItem_ShareSheetThread' }] },
    ],
  };
  assert.deepEqual([...artifactPossibleTypes(fragment).get('__isShareSheetItem')].sort(), ['ShareSheetThread', 'ShareSheetUser']);
});
