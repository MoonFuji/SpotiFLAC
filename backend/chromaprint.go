package backend

import (
	"context"
	"fmt"
	"math/bits"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// ChromaprintFingerprint holds the result of fpcalc (chromaprint-tools).
// DurationSec is from the actual audio; Fingerprint is raw 32-bit subfingerprints for Hamming comparison.
type ChromaprintFingerprint struct {
	DurationSec int
	Fingerprint []uint32
}

// defaultFpcalcLengthSec is how many seconds of audio fpcalc uses (default 120).
const defaultFpcalcLengthSec = 120

// calculateChromaprint runs fpcalc (from chromaprint-tools) on the given audio file.
// Requires fpcalc on PATH (e.g. install libchromaprint-tools). If fpcalc is missing or fails,
// returns nil and no error (caller treats as "no fingerprint available").
func calculateChromaprint(ctx context.Context, path string) (*ChromaprintFingerprint, error) {
	// fpcalc -raw outputs DURATION=<sec> and FINGERPRINT=<space-separated uint32s>
	cmd := exec.CommandContext(ctx, "fpcalc", "-raw", "-length", strconv.Itoa(defaultFpcalcLengthSec), path)
	out, err := cmd.Output()
	if err != nil {
		if _, ok := err.(*exec.ExitError); ok {
			return nil, nil // fpcalc failed (e.g. unsupported format) — treat as no fingerprint
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, nil // e.g. exec not found (fpcalc not installed)
	}

	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	var durationSec int
	var fp []uint32
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "DURATION=") {
			s := strings.TrimPrefix(line, "DURATION=")
			// May be "123" or "123.456"
			if idx := strings.Index(s, "."); idx >= 0 {
				s = s[:idx]
			}
			durationSec, _ = strconv.Atoi(s)
			continue
		}
		if strings.HasPrefix(line, "FINGERPRINT=") {
			s := strings.TrimPrefix(line, "FINGERPRINT=")
			// Raw format: space- or comma-separated 32-bit decimals
			parts := strings.FieldsFunc(s, func(r rune) bool { return r == ' ' || r == ',' })
			fp = make([]uint32, 0, len(parts))
			for _, p := range parts {
				p = strings.TrimSpace(p)
				if p == "" {
					continue
				}
				u, err := strconv.ParseUint(p, 10, 32)
				if err != nil {
					continue
				}
				fp = append(fp, uint32(u))
			}
			break
		}
	}
	if len(fp) == 0 {
		return nil, nil
	}
	return &ChromaprintFingerprint{DurationSec: durationSec, Fingerprint: fp}, nil
}

// FingerprintsMatch returns true if two raw Chromaprint fingerprints are likely the same audio.
// threshold is max allowed average bit error rate (e.g. 0.15 = 15% of bits may differ).
// Different encodings/bitrates of the same track typically stay under ~10%.
func FingerprintsMatch(fp1, fp2 []uint32, threshold float64) bool {
	if len(fp1) == 0 || len(fp2) == 0 {
		return false
	}
	// Use the shorter length so we don't penalize different trim lengths
	n := len(fp1)
	if len(fp2) < n {
		n = len(fp2)
	}
	if n == 0 {
		return false
	}
	var distance int
	for i := 0; i < n; i++ {
		distance += bits.OnesCount32(fp1[i] ^ fp2[i])
	}
	totalBits := 32 * n
	return float64(distance)/float64(totalBits) < threshold
}

// ChromaprintTimeout is how long we allow a single fpcalc invocation (it can be slow on large files).
var ChromaprintTimeout = 30 * time.Second

// FingerprintDurationOK returns true if two durations are close enough to be the same track
// (±5 seconds or ±2%, whichever is larger). Used as pre-filter before comparing fingerprints.
func FingerprintDurationOK(duration1Ms, duration2Ms int) bool {
	if duration1Ms <= 0 || duration2Ms <= 0 {
		return true
	}
	diff := duration1Ms - duration2Ms
	if diff < 0 {
		diff = -diff
	}
	maxMs := 5000 // 5 seconds
	if duration2Ms > duration1Ms {
		if pct := int(float64(duration2Ms) * 0.02); pct > maxMs {
			maxMs = pct
		}
	} else {
		if pct := int(float64(duration1Ms) * 0.02); pct > maxMs {
			maxMs = pct
		}
	}
	return diff <= maxMs
}

// calculateChromaprintWithTimeout runs fpcalc with a timeout so one slow file doesn't block the scan.
func calculateChromaprintWithTimeout(ctx context.Context, path string) (*ChromaprintFingerprint, error) {
	ctx2, cancel := context.WithTimeout(ctx, ChromaprintTimeout)
	defer cancel()
	result, err := calculateChromaprint(ctx2, path)
	if err != nil {
		return nil, fmt.Errorf("chromaprint: %w", err)
	}
	return result, nil
}
