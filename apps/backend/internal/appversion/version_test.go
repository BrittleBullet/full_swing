package appversion

import (
	"os"
	"testing"
)

func TestCurrentMatchesRepoVersionFile(t *testing.T) {
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("failed to get working directory: %v", err)
	}

	versionPath := searchUpwards(cwd)
	if versionPath == "" {
		t.Fatal("expected to resolve VERSION from the repository tree")
	}

	data, err := os.ReadFile(versionPathFile(cwd))
	if err != nil {
		t.Fatalf("failed to read VERSION file: %v", err)
	}

	expected := string(data)
	if got := Current(); got != trimVersion(expected) {
		t.Fatalf("expected version %q, got %q", trimVersion(expected), got)
	}
}

func versionPathFile(startDir string) string {
	currentDir := startDir
	for {
		candidate := currentDir + string(os.PathSeparator) + versionFileName
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}

		parentDir := filepathDir(currentDir)
		if parentDir == currentDir {
			return ""
		}
		currentDir = parentDir
	}
}

func filepathDir(value string) string {
	index := len(value) - 1
	for index >= 0 && os.IsPathSeparator(value[index]) {
		index--
	}
	for index >= 0 && !os.IsPathSeparator(value[index]) {
		index--
	}
	if index <= 0 {
		return value[:1]
	}
	return value[:index]
}

func trimVersion(value string) string {
	end := len(value)
	for end > 0 && (value[end-1] == '\n' || value[end-1] == '\r' || value[end-1] == ' ' || value[end-1] == '\t') {
		end--
	}
	start := 0
	for start < end && (value[start] == '\n' || value[start] == '\r' || value[start] == ' ' || value[start] == '\t') {
		start++
	}
	return value[start:end]
}
