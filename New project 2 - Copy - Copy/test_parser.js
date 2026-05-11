const { parseOutput } = require('./agent/output_parser');

const tests = [
  {
    name: '1. Smart quotes in MEM_SAVE',
    input: `[MEM_SAVE short] {"type":"task","content":"hello","priority":"high","why":"task.”}`
  },
  {
    name: '2. Topic-based MEM_FOCUS',
    input: `[MEM_FOCUS] {"topic":"cognitive pressure valve","limit":3}`
  },
  {
    name: '3. Bare MEM_SAVE',
    input: `[MEM_SAVE] I should save this later.`
  }
];

let failed = 0;

for (const t of tests) {
  console.log(`\n--- Test: ${t.name} ---`);
  const result = parseOutput(t.input);
  console.log(JSON.stringify(result, null, 2));
  
  if (t.name.startsWith('1')) {
    if (result.saves.length > 0 && result.saves[0].entry.priority === 'high') {
      console.log('✅ Pass');
    } else {
      console.log('❌ Fail');
      failed++;
    }
  } else if (t.name.startsWith('2')) {
    if (result.focusTopics.length > 0 && result.focusTopics[0].topic === 'cognitive pressure valve') {
      console.log('✅ Pass');
    } else {
      console.log('❌ Fail');
      failed++;
    }
  } else if (t.name.startsWith('3')) {
    if (result.saves.length === 0 && result.helpRequests.includes('MEM_SAVE')) {
      console.log('✅ Pass');
    } else {
      console.log('❌ Fail');
      failed++;
    }
  }
}

if (failed === 0) {
  console.log('\n✅ ALL TESTS PASSED');
} else {
  console.log(`\n❌ ${failed} TESTS FAILED`);
}
