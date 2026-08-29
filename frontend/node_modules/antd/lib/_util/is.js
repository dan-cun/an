"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.isWindow = exports.isTransitionEvent = exports.isThenable = exports.isString = exports.isReactRenderable = exports.isPrimitive = exports.isPlainObject = exports.isNumber = exports.isNonNullable = exports.isHTMLElement = exports.isFunction = exports.isDocument = void 0;
const isNonNullable = val => {
  return val !== undefined && val !== null;
};
exports.isNonNullable = isNonNullable;
const isReactRenderable = val => {
  return isNonNullable(val) && val !== false && val !== '';
};
exports.isReactRenderable = isReactRenderable;
const isNumber = val => {
  return typeof val === 'number' && !Number.isNaN(val);
};
exports.isNumber = isNumber;
const isString = val => {
  return typeof val === 'string';
};
exports.isString = isString;
const isPlainObject = val => {
  return val !== null && typeof val === 'object';
};
exports.isPlainObject = isPlainObject;
const isFunction = val => {
  return typeof val === 'function';
};
exports.isFunction = isFunction;
const isThenable = val => {
  return isNonNullable(val) && isFunction(val.then);
};
exports.isThenable = isThenable;
const isPrimitive = val => {
  return typeof val !== 'object' && !isFunction(val) || val === null;
};
exports.isPrimitive = isPrimitive;
const isTransitionEvent = event => {
  return isPlainObject(event) && 'propertyName' in event && isString(event.propertyName);
};
exports.isTransitionEvent = isTransitionEvent;
const isWindow = val => {
  if (!isNonNullable(val)) {
    return false;
  }
  return val === val.window;
};
exports.isWindow = isWindow;
const isDocument = val => {
  if (!isNonNullable(val)) {
    return false;
  }
  return val instanceof Document || val.constructor.name === 'HTMLDocument' || val.nodeType === window.Node.DOCUMENT_NODE;
};
exports.isDocument = isDocument;
const isHTMLElement = val => {
  if (!isNonNullable(val)) {
    return false;
  }
  return typeof HTMLElement !== 'undefined' && val instanceof HTMLElement;
};
exports.isHTMLElement = isHTMLElement;