#!/usr/bin/env bash

# Setup terminal styling colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${CYAN}========================================================================${NC}"
echo -e "${CYAN}          BACKREST END-TO-END DATA INTEGRITY VALIDATION SUITE           ${NC}"
echo -e "${CYAN}========================================================================${NC}"
echo -e "Starting automated recovery and data verification cycle..."
echo ""

# Ensure we are in the root directory
BASEDIR=$(dirname "$0")
cd "$BASEDIR/../.."

# Run the Go E2E integrity test
go test -v ./test/e2e -run TestIntegrityE2E

EXIT_CODE=$?

echo ""
echo -e "${CYAN}========================================================================${NC}"
if [ $EXIT_CODE -eq 0 ]; then
  echo -e "${GREEN}🎉 SUCCESS: Backup & Restore integrity is verified to be 100% PERFECT!${NC}"
  echo -e "${GREEN}Both database (PostgreSQL) and web services (Nginx) were fully recovered.${NC}"
else
  echo -e "${RED}❌ FAILURE: Data integrity validation failed. See output above.${NC}"
fi
echo -e "${CYAN}========================================================================${NC}"

exit $EXIT_CODE
