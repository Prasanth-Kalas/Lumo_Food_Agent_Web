/**
 * Run: node --experimental-strip-types tests/search-restaurants.test.mjs
 */

import assert from "node:assert/strict";

const { searchRestaurantsMock } = await import(`../lib/mock-data.ts?test=${Date.now()}`);

const results = searchRestaurantsMock({
  query: "pizza",
  metro: "chicago",
  limit: 2,
});

assert.equal(results.length, 2);
assert.deepEqual(
  results.map((restaurant) => restaurant.name),
  ["Lou's Deep Dish", "Pequod's Lincoln Park"],
);

console.log("✓ Chicago pizza search returns two options");
