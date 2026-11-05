package home

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"unicode"
)

// Object is a dynamic JSON object used for options, schema validation and hook changes.
// Persistent records use typed structs; agent answers remain json.RawMessage.
type Object map[string]any

// O constructs a dynamic object from alternating keys and values.
func O(kv ...any) Object {
	o := Object{}
	for i := 0; i < len(kv); i += 2 {
		o[kv[i].(string)] = kv[i+1]
	}
	return o
}

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

// Delete removes a property.
func (o Object) Delete(k string) { delete(o, k) }

// Clone copies an object before a hook or follow-up changes it.
func (o Object) Clone() Object {
	out := Object{}
	for k, v := range o {
		out[k] = v
	}
	return out
}

// S returns a string property, or the empty string.
func (o Object) S(k string) string { s, _ := o[k].(string); return s }

// N returns a numeric property, or zero when absent.
func (o Object) N(k string) float64 { return Number(o[k]) }

// B reports a nonempty option or enabled task field; presence checks must use Has.
func (o Object) B(k string) bool { return Truth(o[k]) }

// String formats a scalar task id or an ordinary text answer.
func String(v any) string {
	if v == nil {
		return "null"
	}
	if n, ok := v.(float64); ok {
		return strconv.FormatFloat(n, 'f', -1, 64)
	}
	return fmt.Sprint(v)
}

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

// Kind returns the JSON type name used in validation errors.
func Kind(v any) string {
	if raw, ok := v.(json.RawMessage); ok {
		decoded, _ := ParseJSON(string(raw))
		return Kind(decoded)
	}
	switch v.(type) {
	case nil:
		return "null"
	case bool:
		return "boolean"
	case string:
		return "string"
	case float64, int:
		return "number"
	case []any, []Object:
		return "array"
	default:
		return "object"
	}
}

// Fixed prints fixed decimal places with halves rounded away from zero for status counts.
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

// Trim removes surrounding prompt or report whitespace.
func Trim(s string) string { return strings.TrimFunc(s, Space) }

// TrimEnd preserves leading answer whitespace while removing trailing whitespace.
func TrimEnd(s string) string { return strings.TrimRightFunc(s, Space) }

// UTF8 replaces invalid byte sequences after the complete output stream has been read.
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
		panic(err)
	}
	return strings.TrimSuffix(b.String(), "\n")
}

// ParseJSON uses Go's JSON parser and converts objects to the dynamic validation type.
func ParseJSON(text string) (any, error) {
	var v any
	if err := json.Unmarshal([]byte(text), &v); err != nil {
		return nil, err
	}
	return objects(v), nil
}

// objects converts decoded maps recursively without changing JSON values.
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

// ParsePayload decodes a task/result hook payload, retaining raw answer and schema key order.
func ParsePayload(text string) (Object, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(text), &raw); err != nil {
		return nil, err
	}
	if raw == nil {
		return nil, fmt.Errorf("expected a JSON object")
	}
	o := Object{}
	for k, v := range raw {
		if k == "answer" || k == "schema" {
			o[k] = v
			continue
		}
		if k == "task" || k == "result" {
			if nested, err := ParsePayload(string(v)); err == nil {
				o[k] = nested
				continue
			}
		}
		decoded, err := ParseJSON(string(v))
		if err != nil {
			return nil, err
		}
		o[k] = decoded
	}
	return o, nil
}
