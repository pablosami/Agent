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
    name: '3. Bare MEM_SAVE fallback',
    input: `[MEM_SAVE] - "Initial assessment: We need more sleep."`
  },
  {
    name: '4. Empty MEM_SAVE fallback',
    input: `[MEM_SAVE]`
  },
  {
    name: '5. Bare MEM_DELETE',
    input: `[MEM_DELETE #61 #62]`
  },
  {
    name: '6. REFLECT with prose',
    input: `[REFLECT] – Question: Why did the chicken cross the road?`
  },
  {
    name: '7. SCHEDULE bare',
    input: `[SCHEDULE] 15 mins` // wait, my regex was /^\s*\[SCHEDULE(?:\]\s*|\s+)(\d+)\]?/m
  },
  {
    name: '8. SEND_MESSAGE with prose',
    input: `[SEND_MESSAGE] – "Hello user, I have finished my task."`
  },
  {
    name: '9. MEM_ADAPT with prose',
    input: `[MEM_ADAPT] – Need to reframe the tool usage priority`
  }
];

let failed = 0;

for (const t of tests) {
  console.log(`\n--- Test: ${t.name} ---`);
  const result = parseOutput(t.input);
  console.log(JSON.stringify(result, null, 2));
  
  if (t.name.startsWith('1')) {
    if (result.saves.length > 0 && result.saves[0].entry.priority === 'high') console.log('✅ Pass'); else { console.log('❌ Fail'); failed++; }
  } else if (t.name.startsWith('2')) {
    if (result.focusTopics.length > 0 && result.focusTopics[0].topic === 'cognitive pressure valve') console.log('✅ Pass'); else { console.log('❌ Fail'); failed++; }
  } else if (t.name.startsWith('3')) {
    if (result.saves.length > 0 && result.saves[0].entry.type === 'insight') console.log('✅ Pass'); else { console.log('❌ Fail'); failed++; }
  } else if (t.name.startsWith('4')) {
    if (result.saves.length === 0 && result.helpRequests.includes('MEM_SAVE')) console.log('✅ Pass'); else { console.log('❌ Fail'); failed++; }
  } else if (t.name.startsWith('5')) {
    if (result.deletes.length === 2 && result.deletes[0].id === 61 && !result.deletes[0].kind) console.log('✅ Pass'); else { console.log('❌ Fail'); failed++; }
  } else if (t.name.startsWith('6')) {
    if (result.reflect === true && result.saves.some(s => s.entry.type === 'reflection_request')) console.log('✅ Pass'); else { console.log('❌ Fail'); failed++; }
  } else if (t.name.startsWith('7')) {
    if (result.scheduleSec === 15) console.log('✅ Pass'); else { console.log('❌ Fail'); failed++; }
  } else if (t.name.startsWith('8')) {
    if (result.messages.includes('Hello user, I have finished my task.')) console.log('✅ Pass'); else { console.log('❌ Fail'); failed++; }
  } else if (t.name.startsWith('9')) {
    if (result.saves.some(s => s.entry.content.includes('reframe the tool usage')) && result.helpRequests.includes('MEM_ADAPT')) console.log('✅ Pass'); else { console.log('❌ Fail'); failed++; }
  }
}

if (failed === 0) {
  console.log('\n✅ ALL TESTS PASSED');
} else {
  console.log(`\n❌ ${failed} TESTS FAILED`);
}
