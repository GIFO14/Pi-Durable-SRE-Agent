const response = await fetch(`http://127.0.0.1:${process.env.SRE_PORT ?? 3000}/api/incident`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
});
console.log(await response.text());
if (!response.ok) process.exitCode = 1;
