// credits to: https://github.com/bergie/passport-saml and https://github.com/auth10/passport-wsfed-saml2

var xml2js = require('xml2js');
var xmlCrypto = require('xml-crypto');
var crypto = require('crypto');
var xmldom = require('xmldom');
var querystring = require('querystring');

module.exports.validate = function (samlAssertionString, options, callback) {  
   
   // Verify signature
   if (!validateSignature(samlAssertionString, options.cert, options.thumbprint)) {
     return callback(new Error('Invalid signature.'), null);
   }

   var parser = new xml2js.Parser();
   parser.parseString(samlAssertionString, function (err, samlAssertion) {

    var version;
    if (samlAssertion['@'].MajorVersion === '1')
      version = '1.1';
    else if (samlAssertion['@'].Version === '2.0')
      version = '2.0';
    else
      return callback(new Error('SAML Assertion version not supported'), null);

    if (!validateExpiration(samlAssertion, version)) {
      return callback(new Error('Token has expired.'), null);
    }

    if (!validateAudience(samlAssertion, options.realm, version)) {
      return callback(new Error('Audience is invalid. Expected: ' + options.realm), null);
    }

    var profile = parseAttributes(samlAssertion, version);

    callback(null, profile);
  });
}

function certToPEM(cert) {
  cert = cert.match(/.{1,64}/g).join('\n');
  cert = "-----BEGIN CERTIFICATE-----\n" + cert;
  cert = cert + "\n-----END CERTIFICATE-----\n";
  return cert;
};

 function validateSignature(xml, cert, thumbprint) {

  var doc = new xmldom.DOMParser().parseFromString(xml);
  var signature = xmlCrypto.xpath.SelectNodes(doc, "/*/*[local-name(.)='Signature' and namespace-uri(.)='http://www.w3.org/2000/09/xmldsig#']")[0];
  
  var sig = new xmlCrypto.SignedXml(null, { idAttribute: 'AssertionID' });
  
  var calculatedThumbprint;

  sig.keyInfoProvider = {
    getKeyInfo: function (key) {
      return "<X509Data></X509Data>"
    },
    getKey: function (keyInfo) {
      if (thumbprint)  {
        var embeddedSignature = keyInfo[0].getElementsByTagName("X509Certificate");
        if (embeddedSignature.length > 0) {
          var base64cer = embeddedSignature[0].firstChild.toString();
          var shasum = crypto.createHash('sha1');
          var der = new Buffer(base64cer, 'base64').toString('binary')
          shasum.update(der);
          calculatedThumbprint = shasum.digest('hex');

          return certToPEM(base64cer);
        }
      }
      
      return certToPEM(cert);
    }
  };

  sig.loadSignature(signature.toString());
  var valid = sig.checkSignature(xml);

  if (cert) {
    return valid;
  }

  if (thumbprint) {
    return valid && calculatedThumbprint.toUpperCase() === thumbprint.toUpperCase();
  }
};

 function validateExpiration(samlAssertion, version) {
  var notBefore = new Date(version === '2.0' ? samlAssertion.Conditions['@'].NotBefore : samlAssertion['saml:Conditions']['@'].NotBefore);
  notBefore = notBefore.setMinutes(notBefore.getMinutes() - 10); // 10 minutes clock skew
  
  var notOnOrAfter = new Date(version === '2.0' ? samlAssertion.Conditions['@'].NotOnOrAfter : samlAssertion['saml:Conditions']['@'].NotOnOrAfter);
  notOnOrAfter = notOnOrAfter.setMinutes(notOnOrAfter.getMinutes() + 10); // 10 minutes clock skew

  var now = new Date();

  if (now < notBefore || now > notOnOrAfter)
    return false;

  return true;
};

function validateAudience(samlAssertion, realm, version) {
  var audience = version === '2.0' ? samlAssertion.Conditions.AudienceRestriction.Audience : samlAssertion['saml:Conditions']['saml:AudienceRestrictionCondition']['saml:Audience'];
  return audience === realm;
};

function parseAttributes(samlAssertion, version) {
  var profile = {};
  var attributes;
  if (version === '2.0') {
    attributes = samlAssertion.AttributeStatement.Attribute;
    if (attributes) {
      attributes  = (attributes instanceof Array) ? attributes : [attributes];
      attributes.forEach(function (attribute) {
        var value = attribute.AttributeValue;
        profile[attribute['@'].Name] = value;
      });
    }

    if (samlAssertion.Subject.NameID) {
      profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier'] = samlAssertion.Subject.NameID;
    }
    
  } else {
    attributes = samlAssertion['saml:AttributeStatement']['saml:Attribute'];
    if (attributes) {
      attributes  = (attributes instanceof Array) ? attributes : [attributes];
      attributes.forEach(function (attribute) {
        var value = attribute['saml:AttributeValue'];
        var attributeName = attribute['@'].AttributeNamespace + '/' + attribute['@'].AttributeName;
        profile[attributeName] = value;
      });
    }
    
    if (samlAssertion['saml:AttributeStatement']['saml:Subject']['saml:NameIdentifier']) {
      profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier'] = samlAssertion['saml:AttributeStatement']['saml:Subject']['saml:NameIdentifier'];
    }
  }

  return profile;
};