"use strict";

const fail = () => { throw new Error("Plugin permission denied"); };
// Snapshot data properties once. Never invoke accessors while checking authority.
// This is DTO validation, not protection against hostile same-process Proxies.
function record(value, names) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== names.length) fail();
  const result = {};
  for (const key of names) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail();
    Object.defineProperty(result, key, { value: descriptor.value, enumerable: true });
  }
  return Object.freeze(result);
}
function list(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length.value;
  integer(length, 0, maximum);
  if (Reflect.ownKeys(descriptors).length !== length + 1) fail();
  return Array.from({ length }, (_, i) => {
    const descriptor = descriptors[i];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail();
    return descriptor.value;
  });
}
function integer(n, min, max) { if (!Number.isSafeInteger(n) || n < min || n > max) fail(); }
function name(s) { if (typeof s !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(s)) fail(); }
module.exports = { fail, record, list, integer, name };
