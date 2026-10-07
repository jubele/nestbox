// The fixture virtualenv's python: says how it was started, then runs until stopped.
console.log(`fake python ${process.argv.slice(2).join(' ')}`);
console.log(`VIRTUAL_ENV ${process.env.VIRTUAL_ENV ? 'set' : 'missing'}`);
setInterval(() => {}, 1000);
