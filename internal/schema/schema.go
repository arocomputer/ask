// Package schema validates the documented core JSON Schema keywords; others are ignored.
package schema

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"

	"github.com/arocomputer/ask/internal/home"
)

// same compares JSON values by value, including object properties irrespective of order.
func same(a, b any) bool {
	if home.Kind(a) != home.Kind(b) {
		return false
	}
	switch x := a.(type) {
	case home.Object:
		y, ok := b.(home.Object)
		if !ok || len(x) != len(y) {
			return false
		}
		for key, val := range x {
			if !y.Has(key) || !same(val, y.Get(key)) {
				return false
			}
		}
		return true
	case []any:
		y := b.([]any)
		if len(x) != len(y) {
			return false
		}
		for i, v := range x {
			if !same(v, y[i]) {
				return false
			}
		}
		return true
	case float64:
		return x == b.(float64)
	default:
		return home.JSON(a, false) == home.JSON(b, false)
	}
}

// Mismatch returns the first path-qualified mismatch, or an error for unusable keyword shapes.
func Mismatch(value, schema any, path string) (string, error) {
	if raw, ok := schema.(json.RawMessage); ok {
		decoded, err := home.ParseJSON(string(raw))
		if err != nil {
			return "", err
		}
		schema = decoded
	}
	if schema == false {
		return path + ": no value is allowed here", nil
	}
	s, ok := schema.(home.Object)
	if !ok {
		return "", nil
	}
	kind := home.Kind(value)
	types := []any{s.Get("type")}
	if a, ok := s.Get("type").([]any); ok {
		types = a
	}
	names := []string{}
	fits := false
	for _, t := range types {
		if !home.Truth(t) {
			continue
		}
		name := home.String(t)
		names = append(names, name)
		if name == kind || (name == "integer" && kind == "number" && !math.IsInf(home.Number(value), 0) && math.Trunc(home.Number(value)) == home.Number(value)) {
			fits = true
		}
	}
	if len(names) > 0 && !fits {
		return fmt.Sprintf("%s: expected %s, got %s", path, strings.Join(names, " or "), kind), nil
	}
	if home.Truth(s.Get("enum")) {
		a, ok := s.Get("enum").([]any)
		if !ok {
			return "", fmt.Errorf("schema enum must be an array")
		}
		found := false
		for _, v := range a {
			if same(v, value) {
				found = true
				break
			}
		}
		if !found {
			return path + ": not one of " + home.JSON(a, false), nil
		}
	}
	if s.Has("const") && !same(s.Get("const"), value) {
		return path + ": must be " + home.JSON(s.Get("const"), false), nil
	}
	if v, ok := value.(home.Object); ok {
		if s.B("required") {
			req, ok := s.Get("required").([]any)
			if !ok {
				return "", fmt.Errorf("schema required must be an array of property names")
			}
			for _, key := range req {
				if !v.Has(home.String(key)) {
					return fmt.Sprintf("%s: missing \"%s\"", path, home.String(key)), nil
				}
			}
		}
		props, _ := s.Get("properties").(home.Object)
		for key, val := range v {
			if props.Has(key) {
				if problem, err := Mismatch(val, props.Get(key), path+"."+key); problem != "" || err != nil {
					return problem, err
				}
			} else if s.Get("additionalProperties") == false {
				return fmt.Sprintf("%s: unexpected \"%s\"", path, key), nil
			}
		}
	}
	if a, ok := value.([]any); ok && s.Has("items") {
		for i, v := range a {
			if problem, err := Mismatch(v, s.Get("items"), fmt.Sprintf("%s[%d]", path, i)); problem != "" || err != nil {
				return problem, err
			}
		}
	}
	return "", nil
}
