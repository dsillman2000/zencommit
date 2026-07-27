import { Adder } from "./adder.js";
import { Multiplier } from "./multiplier.js";
import { Subtractor } from "./subtractor.js";

const adder = new Adder();
console.assert(adder.add(2, 3) === 5, "2 + 3 should be 5");

const multiplier = new Multiplier();
console.assert(multiplier.multiply(2, 3) === 6, "2 * 3 should be 6");

const subtractor = new Subtractor();
console.assert(subtractor.subtract(5, 3) === 2, "5 - 3 should be 2");

console.log("All assertions passed.");
