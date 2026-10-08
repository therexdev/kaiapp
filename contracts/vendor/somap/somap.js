'use babel';

/**
 * @constructor
 * @param {*} [iterable] - An Array or other iterable object whose elements are key-value pairs
 * (arrays with two elements, e.g. [[ 1, 'one' ],[ 2, 'two' ]]).
 * Each key-value pair is added to the new Map; null values are treated as undefined.
 * @param {*} [comparator] - Specifies a function that defines the sort order of the keys.
 * If omitted, the contents are sorted according by natural order of the keys.
 * If <code>a</code> and <code>b</code> are two elements being compared, then:
 * If <code>comparator(a, b)</code> is less than <code>0</code>, sort <code>a</code>
 * to an index lower than <code>b</code>,  i.e. a comes first.
 * If <code>comparator(a, b)</code> returns <code>0</code>, leave <code>a</code> and <code>b</code>
 * unchanged with respect to each other, but sorted with respect to all different elements.
 * If <code>comparator(a, b)</code> is greater than <code>0</code>, sort <code>b</code>
 * to an index lower than a, i.e. b comes first.
 * <code>comparator(a, b)</code> must always return the same value when given a specific pair of
 * elements a and b as its two arguments.
 * If inconsistent results are returned then the sort order is undefined.
 */
function SoMap(iterable, comparator) {
    this.size = 0;
    this.root = null;

    const checkSameType = function (a, b) {
        if (typeof a !== typeof b) {
            throw Error('The two keys are not of the same type: ' + a + '=[' + (typeof a) + '] ' + b + '=[' + (typeof b) + ']');
        }
    }

    this.compare = function (a, b) {
        if (comparator) {
            return comparator(a, b);
        } else if (a !== null && b !== null && a !== undefined && b !== undefined) {
            checkSameType(a, b);

            if (a < b) {
                return -1;
            } else if (a > b) {
                return 1;
            } else if (a == b) {
                return 0;
            }
        }
    }

    this.Node = function (key, value) {
        this.key = key;
        this.value = value;
        this.left = null;
        this.right = null;
    }

    if (iterable) {
        let iterator = iterable[Symbol.iterator]();
        let next = iterator.next();
        while (!next.done) {
            this.set(next.value[0], next.value[1]);
            next = iterator.next();
        }
    }
}

SoMap[Symbol.species] = SoMap;

/**
 * Returns a new Iterator object that contains an array of [key, value]
 * for each element in the SoMap object in defined order.
 * @return The iterator over an array of key-value pairs in defined order
 */
SoMap.prototype[Symbol.iterator] = function () {
    return this.entries();
}

SoMap.prototype[Symbol.toStringTag] = 'SoMap';

/**
 * Sets the value for the key in the SoMap object. Returns the SoMap object.
 * @param {Object} key - The key to identify the value
 * @param {Object} value - The value to set
 */
SoMap.prototype.set = function (key, value) {
    let map = this;

    let insert = function (parent, node) {
        if (parent == null) {
            //empty map
            map.root = node;
            map.size = 1;
        } else if (map.compare(parent.key, node.key) == 0) {
            //same key, replace only value
            parent.value = node.value;
        } else if (map.compare(node.key, parent.key) < 0) {
            //follow left path
            if (parent.left) {
                return insert(parent.left, node);
            } else {
                parent.left = node;
                map.size++;
            }
        } else if (map.compare(node.key, parent.key) > 0) {
            //follow right path
            if (parent.right) {
                return insert(parent.right, node);
            } else {
                parent.right = node;
                map.size++;
            }
        }
        return node;
    }

    let node = new map.Node(key, value);
    insert(map.root, node);
    return map;
}

/**
 * Returns true if an element in the SoMap object existed and has been removed,
 * or false if the element does not exist. SoMap.prototype.has(key) will return false afterwards.
 * @param {Object} key - The key of the element to remove
 */
SoMap.prototype['delete'] = function (key) {
    let map = this;

    let min = function (node) {
        if (node.left) {
            return min(node.left);
        } else {
            return node;
        }
    }

    let del = function (node, key) {
        if (node) {
            if (map.compare(key, node.key) > 0) {
                node.right = del(node.right, key);
            } else if (map.compare(key, node.key) < 0) {
                node.left = del(node.left, key);
            } else if (map.compare(key, node.key) == 0) {
                if (!node.left) {
                    map.size--;
                    return node.right
                } else if (!node.right) {
                    map.size--;
                    return node.left;
                } else {
                    let m = min(node.right);
                    node.key = m.key;
                    node.value = m.value;
                    node.right = del(node.right, node.key);
                }
            }

            return node;
        } else {
            return null;
        }
    }

    map.root = del(map.root, key);
}

/**
 * Removes all key/value pairs from the SoMap object.
 */
SoMap.prototype.clear = function () {
    this.size = 0;
    this.root = null;
}

/**
 * Returns a boolean asserting whether a value has been associated to the key in the SoMap object or not.
 * @param {Object} key - The key to check the existence for
 */
SoMap.prototype.has = function (key) {
    return this.get(key) != null;
}

/**
 * Returns the value associated to the key, or null if there is none.
 * @param {Object} key - The key to get the value for
 */
SoMap.prototype.get = function (key) {
    let map = this;
    let node = this.root;
    while (node) {
        if (map.compare(node.key, key) < 0) {
            node = node.right;
        } else if (map.compare(node.key, key) > 0) {
            node = node.left;
        } else if (map.compare(node.key, key) == 0) {
            return node.value;
        } else {
            return null;
        }
    }
    return null;
}

/**
 * Calls callback once for each key-value pair present in the SoMap object, in defined order.
 * If a thisArg parameter is provided to forEach, it will be used as the this value for each callback.
 * @param {Object} callback - The callback function to call for each key-value pair
 * @param {Object} [thisArg] - If provided, it will be used as the this value for each callback
 */
SoMap.prototype.forEach = function (callback, thisArg) {
    //callback with param: value, key, map, index
    let index = 0;
    let map = this;
    let inOrderTraversal = function (node) {
        if (node) {
            inOrderTraversal(node.left);
            if (thisArg) {
                callback.call(thisArg, node.value, node.key, map, index);
            } else {
                callback(node.value, node.key, map, index);
            }
            index++;
            inOrderTraversal(node.right);
        }
    }

    inOrderTraversal(this.root);
}

/**
 * Returns a new Iterator object that contains an array of [key, value]
 * for each element in the SoMap object in defined order.
 */
SoMap.prototype.entries = function () {
    let i = 0;
    let entries = [];
    this.forEach(function (value, key) {
        entries.push([key, value]);
    });

    return {
        next: function () {
            return i < entries.length ? {
                done: false,
                index: i,
                value: entries[i++]
            } : {
                    done: true,
                    index: i
                }
        },
        index: function () {
            return i;
        },
        [Symbol.iterator]: function () {
            return this;
        },
        return: function () {
            i = entries.length;
            return {
                done: true,
                index: i
            }
        }
    }
}

/**
 * Returns a new Iterator object that contains the keys for each element in the SoMap object in defined order.
 * @return Iterator object with all keys of the SoMap object in defined order
 */
SoMap.prototype.keys = function () {
    let i = 0;
    let entries = [];
    this.forEach(function (value, key) {
        entries.push(key);
    });

    return {
        next: function () {
            return i < entries.length ? {
                done: false,
                index: i,
                value: entries[i++]
            } : {
                    done: true,
                    index: i
                }
        },
        index: function () {
            return i;
        },
        [Symbol.iterator]: function () {
            return this;
        },
        return: function () {
            i = entries.length;
            return {
                done: true,
                index: i
            }
        }
    }
}

/**
 * Returns a new Iterator object that contains the values for each element in the SoMap object in defined order.
 * @return Iterator with all values in defined order
 */
SoMap.prototype.values = function () {
    let i = 0;
    let entries = [];
    this.forEach(function (value, key) {
        entries.push(value);
    });

    return {
        next: function () {
            return i < entries.length ? {
                done: false,
                index: i,
                value: entries[i++]
            } : {
                    done: true,
                    index: i
                }
        },
        index: function () {
            return i;
        },
        [Symbol.iterator]: function () {
            return this;
        },
        return: function () {
            i = entries.length;
            return {
                done: true,
                index: i
            }
        }
    }
}

SoMap.prototype.toString = function () {
    let size = this.size;
    let result = this[Symbol.toStringTag] + ' ' + size + ' {';

    this.forEach(function (value, key, map, i) {
        result += ' ' + key + ' => ' + value;
        result += i < size - 1 ? ',' : '';
    });
    result += ' }';
    return result;
}

/**
 * @return true, if the SoMap does not contain any elements
 */
SoMap.prototype.isEmpty = function () {
    return this.size == 0;
}

/**
 * Returns the minimum key-value pair of the SoMap object
 * @return the minimum key-value pair
 */
SoMap.prototype.min = function () {
    let node = this.root;
    while (node && node.left) {
        node = node.left;
    }
    if (node) {
        return {
            key: node.key,
            value: node.value
        }
    } else {
        return null;
    }
}

/**
 * Returns the maximum key-value pair of the SoMap object
 * @return The maximum key-value pair
 */
SoMap.prototype.max = function () {
    let node = this.root;
    while (node && node.right) {
        node = node.right;
    }
    if (node) {
        return {
            key: node.key,
            value: node.value
        }
    } else {
        return null;
    }

}


/**
* Construct a new SoSet object
* @constructor
 * @param {Object} [iterable] - An Array or other iterable object whose elements values.
 * Each value is added to the new set; null values are treated as undefined.
 * @param {Object} [comparator] - Specifies a function that defines the sort order of the values.
 * If omitted, the contents are sorted according by natural order of the values.
 * If <code>a</code> and <code>b</code> are two elements being compared, then:
 * If <code>comparator(a, b)</code> is less than <code>0</code>, sort <code>a</code>
 * to an index lower than <code>b</code>,  i.e. a comes first.
 * If <code>comparator(a, b)</code> returns <code>0</code>, leave <code>a</code> and <code>b</code>
 * unchanged with respect to each other, but sorted with respect to all different elements.
 * If <code>comparator(a, b)</code> is greater than <code>0</code>, sort <code>b</code>
 * to an index lower than a, i.e. b comes first.
 * <code>comparator(a, b)</code> must always return the same value when given a specific pair of
 * elements a and b as its two arguments.
 * If inconsistent results are returned then the sort order is undefined.
 */
function SoSet(iterable, comparator) {
    this.size = 0;
    this.somap = new SoMap(null, comparator);
    if (iterable) {
        let iterator = iterable[Symbol.iterator]();
        let next = iterator.next();
        while (!next.done) {
            this.add(next.value);
            next = iterator.next();
        }
    }
}

SoSet[Symbol.species] = SoSet;

/**
 * Returns a new Iterator object that contains the values for each element in the SoSet object in defined order
 * @return Iterator over values in defined order
 */
SoSet.prototype[Symbol.iterator] = function () {
    return this.values();
}

SoSet.prototype[Symbol.toStringTag] = 'SoSet';

/**
 * Appends a new element with the given value to the SoSet object. Returns the SoSet object.
 * @param {Object} value - The value to add to the set
 * @return The SoSet object
 */
SoSet.prototype.add = function (value) {
    this.somap.set(value, value);
    this.size = this.somap.size;
    return this;
}

/**
 * Removes all elements from the SoSet object.
 */
SoSet.prototype.clear = function () {
    this.somap.clear();
    this.size = this.somap.size;
}

/**
 * Removes the element associated to the value and returns the value
 * that SoSet.prototype.has(value) would have previously returned.
 * SoSet.prototype.has(value) will return false afterwards.
 * @param {Object} value - The value to remove from the set
 */
SoSet.prototype['delete'] = function (value) {
    this.somap.delete(value);
    this.size = this.somap.size;
}

/**
 * Returns a new Iterator object that contains an array of [value, value]
 * for each element in the SoSet object, in defined order.
 * This is kept similar to the Map object, so that each entry has the same value
 * for its key and value here.
 */
SoSet.prototype.entries = function () {
    return this.somap.entries();
}

/**
 * Calls callback once for each value present in the SoSet object, in defined order.
 * If a thisArg parameter is provided to forEach, it will be used as the this value for each callback.
 * @param {Object} callback - The callback function
 * @param {Object} [thisArg] - The optional this
 */
SoSet.prototype.forEach = function (callback, thisArg) {
    let set = this;
    let setCallback = function (value, key, ignore, index) {
        if (thisArg) {
            callback.call(thisArg, value, key, set, index);
        } else {
            callback(value, key, set, index);
        }
    }
    this.somap.forEach(setCallback, thisArg);
}

/**
 * Returns a boolean asserting whether an element is present with the given value in the SoSet object or not.
 * @param {Object} value - The value to check the existence for
 * @return true if the value exists in the SoSet
 */
SoSet.prototype.has = function (value) {
    return this.somap.has(value);
}

/**
 * Returns a new Iterator object that contains the values for each element in the SoSet object in defined order.
 * @return Iterator over all values in defined order
 */
SoSet.prototype.values = function () {
    return this.somap.values();
}

SoSet.prototype.toString = function () {
    let size = this.size;
    let result = this[Symbol.toStringTag] + ' ' + size + ' {';

    this.forEach(function (value, key, map, i) {
        result += ' ' + value;
        result += i < size - 1 ? ',' : '';
    });
    result += ' }';
    return result;
}

/**
 * @return true if the set is empty
 */
SoSet.prototype.isEmpty = function () {
    return this.somap.isEmpty();
}

/**
 * Returns the minimum value of the SoSet object
 * @return the minimum value
 */
SoSet.prototype.min = function () {
    let min = this.somap.min();
    if (min) {
        return min.value;
    } else {
        return null;
    }
}

/**
 * Returns the maximum value of the SoSet object
 * @return the maximum value
 */
SoSet.prototype.max = function () {
    let max = this.somap.max();
    if (max) {
        return max.value;
    } else {
        return null;
    }
}


//exports
module.exports = {
    SoMap,
    SoSet
};
