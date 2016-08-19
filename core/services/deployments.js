'use strict';
var Promise = require('bluebird');
var models = require('../../models');
var security = require('../../core/utils/security');
var PackageManager = require('./package-manager');
var _ = require('lodash');

var proto = module.exports = function (){
  function Deployments() {

  }
  Deployments.__proto__ = proto;
  return Deployments;
};

proto.promote = function (sourceDeploymentId, destDeploymentId, promoteUid) {
  return models.Deployments.findById(sourceDeploymentId)
  .then(function (sourceDeployment) {
    var lastDeploymentVersionId = _.get(sourceDeployment, 'last_deployment_version_id', 0);
    if (_.lte(lastDeploymentVersionId, 0)) {
      throw new Error('does not exist last_deployment_version_id.');
    }
    return models.DeploymentsVersions.findById(lastDeploymentVersionId)
    .then(function (deploymentsVersions) {
      var packageId = _.get(deploymentsVersions, 'current_package_id', 0);
      if (_.lte(packageId, 0)) {
        throw new Error('does not exist packages.');
      }
      return models.Packages.findById(packageId)
      .then(function (packages) {
        if (_.isEmpty(packages)) {
          throw new Error('does not exist packages.');
        }
        return models.DeploymentsVersions.findOne({
          where: {deployment_id: destDeploymentId, app_version: deploymentsVersions.app_version}}).then(function (data) {
          if (!_.isEmpty(data)) {
            return models.Packages.findById(data.current_package_id).then(function (pa) {
              if (_.eq(_.get(pa, 'package_hash'), packages.package_hash)) {
                throw new Error("The uploaded package is identical to the contents of the specified deployment's current release.");
              }
              return {};
            });
          }
          return {};
        }).then(function () {
          return [sourceDeployment, deploymentsVersions, packages];
        });
      });
    });
  })
  .spread(function (sourceDeployment, deploymentsVersions, packages) {
    var params = {
      releaseMethod: 'Promote',
      releaseUid: promoteUid,
      isMandatory: deploymentsVersions.is_mandatory,
      size: packages.size,
      description: packages.description,
      originalLabel: packages.label,
      originalDeployment: sourceDeployment.name
    };
    var packageManager = new PackageManager();
    return packageManager.createPackage(destDeploymentId, deploymentsVersions.app_version, packages.package_hash, packages.manifest_blob_url, packages.blob_url, params);
  });
};

proto.existDeloymentName = function (appId, name) {
  return models.Deployments.findOne({where: {appid: appId, name: name}})
  .then(function (data) {
    if (!_.isEmpty(data)){
      throw new Error(name + " name does Exist!")
    } else {
      return data;
    }
  });
};

proto.addDeloyment = function (name, appId, uid) {
  var _this = this;
  return models.Users.findById(uid)
  .then(function (user) {
    if (_.isEmpty(user)) {
      throw new Error('can\'t find user');
    }
    return _this.existDeloymentName(appId, name)
    .then(function () {
      var identical = user.identical;
      var deploymentKey = security.randToken(28) + identical;
      return models.Deployments.create({
        appid: appId,
        name: name,
        deployment_key: deploymentKey,
        last_deployment_version_id: 0,
        label_id: 0
      });
    });
  });
};

proto.renameDeloymentByName = function (deploymentName, appId, newName) {
  return this.existDeloymentName(appId, newName)
  .then(function () {
    return models.Deployments.update(
      {name: newName},
      {where: {name: deploymentName,appid: appId}
    })
    .then(function (deployment) {
      if (_.gt(deployment[0], 0)) {
        return {name: newName};
      } else {
        throw new Error('does not find the deployment');
      }
    });
  });
};

proto.deleteDeloymentByName = function (deploymentName, appId) {
  return models.Deployments.destroy({
    where: {name: deploymentName,appid: appId}
  })
  .then(function (rowNum) {
    if (_.gt(rowNum, 0)) {
      return {name: deploymentName + ""};
    } else {
      throw new Error('does not find the deployment');
    }
  });
};

proto.findDeloymentByName = function (deploymentName, appId) {
  return models.Deployments.findOne({
    where: {name: deploymentName,appid: appId}
  });
};

proto.findPackagesAndUserInfos = function (packageId) {
  return models.Packages.findOne({
    where: {id: packageId}
  })
  .then(function (packageInfo) {
    if (!packageInfo) {
      return null;
    }
    return Promise.props({
      packageInfo: packageInfo,
      packageDiffInfo: models.PackagesDiff.findOne({where: {package_id: packageId}}),
      userInfo: models.Users.findOne({where: {id: packageInfo.released_by}}),
    });
  });
};

proto.findDeloymentsPackages = function (deploymentsVersionsId) {
  var self = this;
  return models.DeploymentsVersions.findOne({where: {id: deploymentsVersionsId}})
  .then(function(deploymentsVersionsInfo) {
    if (deploymentsVersionsInfo) {
      return self.findPackagesAndUserInfos(deploymentsVersionsInfo.current_package_id)
      .then(function(rs) {
        if (rs) {
          rs.deploymentsVersions = deploymentsVersionsInfo;
        }
        return rs;
      });
    }
    return null;
  });
};

proto.listDeloyments = function (appId) {
  var self = this;
  return models.Deployments.findAll({where: {appid: appId}})
  .then(function(deploymentsInfos){
    if (_.isEmpty(deploymentsInfos)) {
      return [];
    }
    return Promise.map(deploymentsInfos, function (v) {
      return Promise.props({
        name: v.name,
        key: v.deployment_key,
        package: self.findDeloymentsPackages([v.last_deployment_version_id])
        .then(function (packageVersion) {
          if (!packageVersion) {
            return null;
          }
          return {
            label: _.get(packageVersion, "packageInfo.label"),
            description: _.get(packageVersion, "packageInfo.description"),
            appVersion: _.get(packageVersion, "deploymentsVersions.app_version"),
            isMandatory: _.get(packageVersion, "deploymentsVersions.is_mandatory") == 2 ? true : false,
            packageHash: _.get(packageVersion, "packageInfo.package_hash"),
            blobUrl: _.get(packageVersion, "packageInfo.blob_url"),
            size: _.get(packageVersion, "packageInfo.size"),
            manifestBlobUrl: _.get(packageVersion, "packageInfo.manifest_blob_url"),
            diffAgainstPackageHash: _.get(packageVersion, "packageDiffInfo.diff_against_package_hash"),
            diffBlobUrl: _.get(packageVersion, "packageDiffInfo.diff_blob_url"),
            diffSize: _.get(packageVersion, "packageDiffInfo.diff_size"),
            releaseMethod: _.get(packageVersion, "packageInfo.release_method"),
            uploadTime: _.get(packageVersion, "packageInfo.updated_at"),
            releasedBy: _.get(packageVersion, "userInfo.email"),
          };
        })
      });
    })
  });
};
