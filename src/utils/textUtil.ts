import * as upperCamelCase from "uppercamelcase";

const camelCase = require("camelcase");

/**
 * Returns whether the string are equal ignoring case
 *
 * @param string1 A string to compare
 * @param string2 A string to compare
 */
export function equalsIgnoreCase(string1: string, string2: string): boolean {
    return string1.toLowerCase() === string2.toLowerCase();
}


/**
 * Returns a word that has been transformed using the given case
 *
 * @param word The word being transformed
 * @param textCase The case of the transformed text
 */
export function transformTextCase(word: string, textCase: string): string {
    let transformedText: string = word;
    switch (textCase) {
        case "camelCase":
            transformedText = camelCase(word);
            break;
        case "PascalCase":
            transformedText = upperCamelCase(word);
            break;
        case "lowercase":
            transformedText = word.toLocaleLowerCase();
            break;
        default:
            break;
    }

    return transformedText;
}