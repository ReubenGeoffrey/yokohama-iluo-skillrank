import os
import json
from fix_qc_levels import excel_qc

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
emp_file = os.path.join(BASE_DIR, 'custom_employees.json')
emps = json.load(open(emp_file, encoding='utf-8'))
print(f"Existing custom_employees count: {len(emps)}")

updated_emps = []
matched_qc = 0

for emp in emps:
    emp_no = str(emp.get('empNo', '')).strip().lower()
    if emp.get('dept') == 'QUALITY CONTROL' and emp_no in excel_qc:
        matched_qc += 1
        qc_data = excel_qc[emp_no]
        merged = dict(emp)
        merged.update({
            'name': qc_data['name'],
            'dept': qc_data['dept'],
            'section': qc_data['section'],
            'qualification': qc_data['qualification'],
            'doj': qc_data['doj'],
            'expCount': qc_data['expCount'],
            'yearExp': qc_data['yearExp'],
            'currentLevel': qc_data['currentLevel'],
            'targetLevel': qc_data['targetLevel'],
            'skillLevelAssess2025': qc_data['skillLevelAssess2025'],
            'skillLevelExpBased': qc_data['skillLevelExpBased']
        })
        if 'passwordHash' in emp:
            merged['passwordHash'] = emp['passwordHash']
        updated_emps.append(merged)
    else:
        updated_emps.append(emp)

print(f"Matched QC employees: {matched_qc}")
assert matched_qc == 283, f"Expected 283 QC employees, matched {matched_qc}"
assert len(updated_emps) == len(emps), f"Expected {len(emps)} employees, got {len(updated_emps)}"

# Verify counts in updated_emps
from collections import Counter
qc_updated = [e for e in updated_emps if e.get('dept') == 'QUALITY CONTROL']
qc_levels = Counter([e.get('currentLevel') for e in qc_updated])
print("QC Levels in updated dataset:", qc_levels)
assert qc_levels['O'] == 21, f"Expected 21 O, got {qc_levels['O']}"
assert qc_levels['U'] == 104, f"Expected 104 U, got {qc_levels['U']}"
assert qc_levels['L'] == 35, f"Expected 35 L, got {qc_levels['L']}"
assert qc_levels['I'] == 123, f"Expected 123 I, got {qc_levels['I']}"

# Save to custom_employees.json
with open(emp_file, 'w', encoding='utf-8') as f:
    json.dump(updated_emps, f, indent=2, ensure_ascii=False)

print("SUCCESS: custom_employees.json updated and verified with exact levels (O: 21, U: 104, L: 35, I: 123)!")
