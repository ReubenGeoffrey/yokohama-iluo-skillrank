import openpyxl
import json
from collections import Counter

# 1. Load Excel
wb = openpyxl.load_workbook('QA_Workman name list_24.09.2026.xlsx', data_only=True)
sheet = wb['Name list']

excel_qc = {}
for row in sheet.iter_rows(min_row=2, values_only=True):
    emp_no = str(row[1]).strip() if row[1] is not None else ''
    if not emp_no:
        continue
    name = str(row[2]).strip() if row[2] else ''
    dept = 'QUALITY CONTROL'
    section = str(row[4]).strip() if row[4] else 'Final Finish QA'
    qualification = str(row[5]).strip() if row[5] else 'ITI'
    
    doj = '-'
    if row[6]:
        if hasattr(row[6], 'strftime'):
            doj = row[6].strftime('%Y-%m-%d')
        else:
            doj = str(row[6])[:10]
            
    exp_count = row[8] if row[8] is not None else 0
    year_exp = str(row[9]).strip() if row[9] else '-'
    skill_exp = str(row[10]).strip() if row[10] else 'I'
    skill_2025 = str(row[11]).strip() if row[11] else None
    
    # Current level: exactly as per Assessment 2025
    if skill_2025 in ['O', 'U', 'L', 'I']:
        curr_lvl = skill_2025
    else:
        curr_lvl = 'I' # Unassessed / Initial
        
    # Target level: experience based
    if skill_exp in ['O', 'U', 'L', 'I']:
        target_lvl = skill_exp
    else:
        target_lvl = 'L' if curr_lvl == 'I' else curr_lvl
        
    excel_qc[emp_no.lower()] = {
        'empNo': emp_no,
        'name': name,
        'dept': dept,
        'section': section,
        'qualification': qualification,
        'doj': doj,
        'expCount': exp_count,
        'yearExp': year_exp,
        'currentLevel': curr_lvl,
        'targetLevel': target_lvl,
        'skillLevelAssess2025': skill_2025,
        'skillLevelExpBased': skill_exp
    }

print(f"Total QC in Excel: {len(excel_qc)}")
curr_counter = Counter([e['currentLevel'] for e in excel_qc.values()])
print("Current Level Counts (Fixed):", curr_counter)
assert curr_counter['O'] == 21, f"Expected 21 O, got {curr_counter['O']}"
assert curr_counter['U'] == 104, f"Expected 104 U, got {curr_counter['U']}"
assert curr_counter['L'] == 35, f"Expected 35 L, got {curr_counter['L']}"
assert curr_counter['I'] == 123, f"Expected 123 I, got {curr_counter['I']}"
print("ASSERTIONS PASSED: O is exactly 21, U is exactly 104!")
