// A child that never answers: it spins until it is killed.
let n = 0;
for (;;) n = (n + 1) % 1_000_000;

export {};
