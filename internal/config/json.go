package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"unicode"
)

// Object is a dynamic JSON object, used for config, credentials and command-line options.
// Persistent records use typed structs.
type Object map[string]any

// Get returns a property, or nil when absent.
func (o Object) Get(k string) any { return o[k] }

// Has distinguishes an absent property from an explicit null or false.
func (o Object) Has(k string) bool { _, ok := o[k]; return ok }

// Set replaces or adds a property, allocating an empty object when needed.
func (o *Object) Set(k string, v any) {
	if *o == nil {
		*o = Object{}
	}
	(*o)[k] = v
}

// S returns a string property, or the empty string.
func (o Object) S(k string) string { s, _ := o[k].(string); return s }

// N returns a numeric property, or zero when absent.
func (o Object) N(k string) float64 { return Number(o[k]) }

// B reports a nonempty option or enabled field; presence checks must use Has.
func (o Object) B(k string) bool { return Truth(o[k]) }

// Number reads a decoded JSON number or decimal option; invalid values return NaN.
func Number(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int:
		return float64(x)
	case nil:
		return 0
	case string:
		n, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		if err == nil {
			return n
		}
	}
	return math.NaN()
}

// Truth reports nonempty values for options and optional fields, retaining false booleans.
func Truth(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0 && !math.IsNaN(x)
	case int:
		return x != 0
	}
	return true
}

// Fixed prints fixed decimal places with halves rounded away from zero.
func Fixed(n float64, digits int) string {
	scale := math.Pow10(digits)
	return strconv.FormatFloat(math.Round(n*scale)/scale, 'f', digits, 64)
}

// Dollars writes an amount of USD for people: cents from a cent up, every digit below one.
func Dollars(n float64) string {
	if n >= 0.01 {
		return Fixed(n, 2)
	}
	return strconv.FormatFloat(n, 'f', -1, 64)
}

// Space recognizes whitespace accepted around prompts and model specifications.
func Space(r rune) bool { return unicode.IsSpace(r) || r == '\ufeff' }

// Trim removes surrounding whitespace.
func Trim(s string) string { return strings.TrimFunc(s, Space) }

// UTF8 replaces invalid byte sequences in text read from files and processes.
func UTF8(b []byte) string { return strings.ToValidUTF8(string(b), "�") }

// JSON encodes readable JSON without HTML escaping, optionally with two-space indentation.
func JSON(v any, pretty bool) string {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if pretty {
		e.SetIndent("", "  ")
	}
	if err := e.Encode(v); err != nil {
		panic(fmt.Sprintf("encoding JSON: %v", err))
	}
	return strings.TrimSuffix(b.String(), "\n")
}

// ParseJSON uses Go's JSON parser and converts objects to Object recursively.
func ParseJSON(text string) (any, error) {
	var v any
	if err := json.Unmarshal([]byte(text), &v); err != nil {
		return nil, err
	}
	return objects(v), nil
}

func objects(v any) any {
	switch x := v.(type) {
	case map[string]any:
		o := Object{}
		for k, v := range x {
			o[k] = objects(v)
		}
		return o
	case []any:
		for i, v := range x {
			x[i] = objects(v)
		}
	}
	return v
}
