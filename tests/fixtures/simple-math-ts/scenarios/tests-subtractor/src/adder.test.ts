import { Adder } from "./adder.js";

const adder = new Adder();
console.assert(adder.add(2, 3) === 5, "2 + 3 should be 5");
console.assert(adder.add(-1, 1) === 0, "-1 + 1 should be 0");
console.assert(adder.add(0, 0) === 0, "0 + 0 should be 0");

console.log("Adder tests passed.");
