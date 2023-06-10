import { RdhHelper, ResultSetDataBuilder, RowHelper } from '../resource';
import {
  CompareKey,
  RdhRow,
  ResultSetData,
  TableRule,
  TableRuleDetail,
} from '../types';
import {
  AllConditions,
  AnyConditions,
  Engine,
  TopLevelCondition,
} from 'json-rules-engine';

function isAllConditions(item: any): item is AllConditions {
  return item.all && item.all.length !== undefined;
}
function isAnyConditions(item: any): item is AnyConditions {
  return item.any && item.any.length !== undefined;
}
function isTopLevelCondition(item: any): item is TopLevelCondition {
  return isAllConditions(item) || isAnyConditions(item);
}

export type DiffResult = {
  ok: boolean;
  deleted: number;
  inserted: number;
  updated: number;
  message: string;
};

export const diff = (rdh1: ResultSetData, rdh2: ResultSetData): DiffResult => {
  const result: DiffResult = {
    ok: false,
    deleted: 0,
    inserted: 0,
    updated: 0,
    message: '',
  };
  if (!rdh1.meta?.compareKeys || rdh1.meta?.compareKeys.length === 0) {
    result.message = 'Missing compare key (Primary or uniq key).';
    return result;
  }
  const rdb1 = ResultSetDataBuilder.from(rdh1);
  const rdb2 = ResultSetDataBuilder.from(rdh2);

  const keynames = rdb1.keynames();
  const compareKey = getAvailableCompareKey(keynames, rdh1.meta?.compareKeys);
  if (!compareKey) {
    result.message = 'Missing available compare key (Primary or uniq key).';
    return result;
  }

  const hasAlreadyChecked = new Set<string>();

  RdhHelper.clearAllAnotations(rdb1.rs);
  RdhHelper.clearAllAnotations(rdb2.rs);

  rdh1.rows.forEach((row1) => {
    const key1 = createCompareKeysValue(compareKey, row1);
    hasAlreadyChecked.add(key1);
    let removed = true;
    for (const row2 of rdh2.rows) {
      const key2 = createCompareKeysValue(compareKey, row2);
      if (key1 === key2) {
        removed = false;
        // Update
        let updated = false;
        keynames.forEach((name) => {
          const v1 = row1.values[name]?.toString() ?? '';
          const v2 = row2.values[name]?.toString() ?? '';
          if (v1 != v2) {
            updated = true;
            RowHelper.pushAnnotation(row1, name, {
              type: 'Upd',
              values: {
                otherValue: row2.values[name],
              },
            });
            RowHelper.pushAnnotation(row2, name, {
              type: 'Upd',
              values: {
                otherValue: row1.values[name],
              },
            });
          }
        });
        if (updated) {
          result.updated++;
        }
        break;
      }
    }
    if (removed) {
      keynames.forEach((name) => {
        RowHelper.pushAnnotation(row1, name, { type: 'Del' });
      });
      result.deleted++;
    }
  });

  rdh2.rows.forEach((row2) => {
    const key2 = createCompareKeysValue(compareKey, row2);
    if (!hasAlreadyChecked.has(key2)) {
      keynames.forEach((name) => {
        RowHelper.pushAnnotation(row2, name, { type: 'Add' });
      });
      result.inserted++;
    }
  });
  result.ok = true;
  if (result.inserted === 0 && result.deleted === 0 && result.updated === 0) {
    result.message = 'No changes';
  } else {
    result.message = `Inserted:${result.inserted}, Deleted:${result.deleted}, Updated:${result.updated}`;
  }

  return result;
};

/**
 *
 * @ref https://github.com/CacheControl/json-rules-engine/blob/beb656df2502c8716ffab9dc37dc134271b56506/docs/rules.md#operators
 * @param rdh
 * @param rules
 */
export const runRuleEngine = async (
  rdh: ResultSetData,
  tableRule: TableRule,
): Promise<boolean> => {
  let ok = true;
  const engine = new Engine();

  rdh.meta.tableRule = tableRule;

  // ADD CUSTOM OPERATORS
  engine.addOperator('isNull', (factValue) => {
    return factValue === null;
  });
  engine.addOperator('isNotNull', (factValue) => {
    return factValue !== null;
  });
  engine.addOperator('isNil', (factValue) => {
    return factValue === null || factValue === undefined;
  });
  engine.addOperator('isNotNil', (factValue) => {
    return factValue !== null && factValue !== undefined;
  });
  engine.addOperator('startsWith', (factValue, jsonValue) => {
    const v = (factValue ?? '').toString();
    if (v.length === 0) {
      return false;
    }
    return v.startsWith(jsonValue.toString());
  });
  engine.addOperator('endsWith', (factValue, jsonValue) => {
    const v = (factValue ?? '').toString();
    if (v.length === 0) {
      return false;
    }
    return v.endsWith(jsonValue.toString());
  });

  const limitCounters: {
    [key: string]: {
      limit: number;
      count: number;
    };
  } = {};

  tableRule.details.forEach((detail, idx) => {
    limitCounters[detail.ruleName] = {
      limit: detail.error.limit,
      count: 0,
    };

    engine.addRule({
      conditions: detail.conditions,
      event: {
        type: `type${idx}`,
        params: detail.error,
      },
      name: detail.ruleName,
    });
  });

  for (const row of rdh.rows) {
    const facts = RowHelper.getRuleEngineValues(row, rdh.keys);
    const { failureResults } = await engine.run(facts);
    if (failureResults.length) {
      ok = false;
      for (const result of failureResults) {
        const { event, name, conditions } = result;
        const error = event.params as TableRuleDetail['error'];
        const message = `Error: ${name}`;
        const conditionValues = getConditionalValues(conditions, facts);

        if (limitCounters[name].count < limitCounters[name].limit) {
          RowHelper.pushAnnotation(row, error.column, {
            type: 'Rul',
            values: {
              name,
              message,
              conditionValues,
            },
          });
          limitCounters[name].count++;
        }
      }
    }
    if (Object.values(limitCounters).every((v) => v.count >= v.limit)) {
      break;
    }
  }
  return ok;
};

function getConditionalValues(
  condition: TopLevelCondition,
  facts: { [key: string]: any },
): { [key: string]: any } {
  let obj = {};

  const nestedList = isAllConditions(condition) ? condition.all : condition.any;
  for (const nest of nestedList) {
    if (isTopLevelCondition(nest)) {
      obj = {
        ...obj,
        ...getConditionalValues(nest, facts),
      };
    } else {
      // condition
      obj[nest.fact] = facts[nest.fact];
      if (
        typeof nest.value === 'object' &&
        nest.value?.fact &&
        typeof nest.value.fact === 'string'
      ) {
        obj[nest.value.fact] = facts[nest.value.fact];
      }
    }
  }
  return obj;
}

function createCompareKeysValue(compareKey: CompareKey, row1: RdhRow): string {
  if (compareKey.kind === 'primary' || compareKey.kind === 'custom') {
    return compareKey.names.map((k) => row1.values[k] ?? '').join('|:|');
  }
  return row1.values[compareKey.name] ?? '';
}

function getAvailableCompareKey(
  keynames: string[],
  compareKeys: CompareKey[],
): CompareKey | undefined {
  for (const ckey of compareKeys) {
    if (ckey.kind === 'primary' || ckey.kind === 'custom') {
      if (ckey.names.every((it) => keynames.includes(it))) {
        return ckey;
      }
    } else if (ckey.kind === 'uniq') {
      if (keynames.includes(ckey.name)) {
        return ckey;
      }
    }
  }
  return undefined;
}
