/** 极简测试框架：零依赖，失败时以非零码退出。 */

const tests = [];
let passed = 0;
const failures = [];

export function test(name, fn) {
  tests.push({ name, fn });
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

export function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg || '值不相等'}\n  期望: ${b}\n  实际: ${a}`);
}

export async function run() {
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  \u2713 ${t.name}`);
    } catch (e) {
      failures.push({ name: t.name, error: e });
      console.log(`  \u2717 ${t.name}\n      ${e.message.split('\n').join('\n      ')}`);
    }
  }
  console.log(`\n${passed}/${tests.length} 通过`);
  if (failures.length) {
    console.log(`\n失败用例：`);
    for (const f of failures) console.log(`  - ${f.name}: ${f.error.message}`);
    process.exit(1);
  }
}