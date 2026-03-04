#!/bin/bash

# Test runner script for GenAI Underwriting Workbench
# Usage: ./run-tests.sh [backend|cdk|frontend|all] [--coverage]

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Parse arguments
TEST_SUITE="${1:-all}"
COVERAGE_FLAG="${2}"

echo "=========================================="
echo "GenAI Underwriting Workbench - Test Suite"
echo "=========================================="
echo ""

# Function to run backend tests
run_backend_tests() {
    echo -e "${YELLOW}Running Backend Lambda Tests...${NC}"
    cd cdk/lambda-functions
    
    # Activate venv if it exists, create if not
    if [ ! -d "venv" ]; then
        echo "Creating virtual environment..."
        python3 -m venv venv
        source venv/bin/activate
        pip install -q pytest pytest-cov boto3 pdf2image
    else
        source venv/bin/activate
    fi
    
    # Run tests for each lambda directory separately to avoid import conflicts
    PASSED=0
    FAILED=0
    
    for dir in */; do
        if ls "${dir}"test_*.py 1> /dev/null 2>&1; then
            echo "Testing ${dir%/}..."
            cd "$dir"
            if pytest test_*.py -q; then
                ((PASSED++))
            else
                ((FAILED++))
            fi
            cd ..
        fi
    done
    
    echo ""
    echo "Backend Test Summary: $PASSED passed, $FAILED failed"
    
    cd ../..
    
    if [ $FAILED -eq 0 ]; then
        echo -e "${GREEN}✓ Backend tests completed${NC}"
    else
        echo -e "${RED}✗ Some backend tests failed${NC}"
        return 1
    fi
    echo ""
}

# Function to run CDK tests
run_cdk_tests() {
    echo -e "${YELLOW}Running CDK Infrastructure Tests...${NC}"
    cd cdk
    
    if [ "$COVERAGE_FLAG" == "--coverage" ]; then
        npm test -- --coverage --coverageDirectory=../coverage/cdk
        echo -e "${GREEN}✓ CDK coverage report: coverage/cdk/index.html${NC}"
    else
        npm test
    fi
    
    cd ..
    echo -e "${GREEN}✓ CDK tests completed${NC}"
    echo ""
}

# Function to run frontend tests
run_frontend_tests() {
    echo -e "${YELLOW}Running Frontend Tests...${NC}"
    cd frontend
    
    if [ "$COVERAGE_FLAG" == "--coverage" ]; then
        npm test -- --coverage --coverage.reportsDirectory=../coverage/frontend
        echo -e "${GREEN}✓ Frontend coverage report: coverage/frontend/index.html${NC}"
    else
        npm test
    fi
    
    cd ..
    echo -e "${GREEN}✓ Frontend tests completed${NC}"
    echo ""
}

# Main execution
case $TEST_SUITE in
    backend)
        run_backend_tests
        ;;
    cdk)
        run_cdk_tests
        ;;
    frontend)
        run_frontend_tests
        ;;
    all)
        run_backend_tests
        run_cdk_tests
        run_frontend_tests
        ;;
    *)
        echo -e "${RED}Invalid test suite: $TEST_SUITE${NC}"
        echo "Usage: ./run-tests.sh [backend|cdk|frontend|all] [--coverage]"
        exit 1
        ;;
esac

echo "=========================================="
echo -e "${GREEN}All tests completed successfully!${NC}"
echo "=========================================="
