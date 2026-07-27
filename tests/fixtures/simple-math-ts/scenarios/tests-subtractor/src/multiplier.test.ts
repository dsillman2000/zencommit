import { Multiplier } from "./multiplier.js";

const multiplier = new Multiplier();
console.assert(multiplier.multiply(2, 3) === 6, "2 * 3 should be 6");
console.assert(multiplier.multiply(-1, 1) === -1, "-1 * 1 should be -1");
console.assert(multiplier.multiply(0, 5) === 0, "0 * 5 should be 0");

console.log("Multiplier tests passed.");
